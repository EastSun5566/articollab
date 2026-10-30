// @ts-check
import { Annotation, EditorState, StateEffect, StateField } from "@codemirror/state";
import { createMirror, editorEdits, editorOffset, elementIndexAt, mirrorElements, textEdits } from "./changes.js";

const fromText = Annotation.define();

/** @typedef {import("../../dist/index.js").Cursor} Cursor */
/** @typedef {{ readonly from: Cursor, readonly to: Cursor }} CursorSelection */
/** @typedef {{ readonly label: string, readonly selection: CursorSelection }} RemoteSelection */
/** A remote selection in current UTF-16 offsets; `from === to` is a caret.
 * @typedef {{ readonly label: string, readonly from: number, readonly to: number }} RemoteRange */
/** Whether a remote selection resolved here, with element indices when it did.
 * @typedef {{ readonly label: string, readonly resolved: false } |
 *   { readonly label: string, readonly resolved: true, readonly from: number, readonly to: number }} RemoteStatus */

/** @type {import("@codemirror/state").StateEffectType<readonly RemoteRange[]>} */
const setRemoteRanges = StateEffect.define();

/** Resolved remote selections. Between re-resolutions, CodeMirror maps them like the cursors' binds:
 * a range start stays after text inserted at it, and a range end or caret stays before. */
export const remoteRanges = StateField.define({
  /** @returns {readonly RemoteRange[]} */
  create: () => [],
  update(ranges, transaction) {
    for (const effect of transaction.effects) if (effect.is(setRemoteRanges)) return effect.value;
    if (!transaction.docChanged) return ranges;
    return ranges.map((range) => {
      const to = transaction.changes.mapPos(range.to, -1);
      const from = range.from === range.to ? to : Math.min(transaction.changes.mapPos(range.from, 1), to);
      return { label: range.label, from, to };
    });
  },
});

/** This example-only bridge also runs with EditorState alone in Node tests.
 * @param {{state: {body: import("../../dist/index.js").Text},
 *   transact: (callback: () => void) => void, readonly replayConflict: unknown}} doc
 * @param {{update: (transactions: readonly import("@codemirror/state").Transaction[]) => void,
 *   canEdit: () => boolean, onError: (error: unknown) => void,
 *   onLocalEdit?: () => void, extensions?: import("@codemirror/state").Extension,
 *   onSelection?: () => void, onRemote?: (statuses: readonly RemoteStatus[]) => void}} options
 */
export function createTextBinding(doc, options) {
  let mirror = createMirror(doc.state.body);
  let state = EditorState.create({ doc: doc.state.body.toString(), extensions: [
    EditorState.lineSeparator.of("\n"), remoteRanges, options.extensions ?? [],
  ] });
  /** @type {readonly RemoteSelection[]} */
  let remote = [];
  let local = false, destroyed = false, failed = false;
  /** @type {unknown} */
  let failure;
  /** @param {unknown} error @returns {never} */
  function stop(error) {
    if (failed) throw failure;
    failed = true;
    failure = error;
    try { options.onError(error); }
    catch { /* Reporting a failure must not replace it. */ }
    throw failure;
  }

  /** @param {readonly import("@codemirror/state").Transaction[]} transactions */
  function dispatch(transactions) {
    if (destroyed) throw new Error("Text binding is destroyed");
    let docChanged = false, moved = false;
    for (const transaction of transactions) {
      docChanged ||= transaction.docChanged;
      moved ||= transaction.docChanged || transaction.selection !== undefined;
      if (transaction.startState !== state) stop(new Error("Stale editor transaction"));
      if (transaction.docChanged && failed) throw failure;
      const external = transaction.annotation(fromText) === true;
      // Busy is a precondition, not a permanent failure of an in-flight sync.
      if (transaction.docChanged && !external && (!options.canEdit() || doc.replayConflict !== null)) {
        throw new Error("Editor is read-only");
      }
      try {
        if (transaction.docChanged && !external) {
          const edits = editorEdits(mirror, transaction);
          local = true;
          try {
            if (edits.length !== 0) doc.transact(() => {
              for (const edit of edits) {
                if (edit.deleteCount !== 0) doc.state.body.delete(edit.index, edit.deleteCount);
                if (edit.insert !== "") doc.state.body.insert(edit.index, edit.insert);
              }
            });
          } finally { local = false; }
          if (edits.length !== 0) options.onLocalEdit?.();
        }
        state = transaction.state;
        options.update([transaction]);
      } catch (error) { stop(error); }
    }
    // Re-resolve from the cursors: mapped offsets cannot know about deleted or newly known anchors.
    if (docChanged && remote.length !== 0) resolveRemote();
    if (moved) options.onSelection?.();
  }

  /** @returns {readonly RemoteStatus[]} */
  function resolveRemote() {
    /** @type {RemoteStatus[]} */
    const statuses = [];
    /** @type {RemoteRange[]} */
    const ranges = [];
    try {
      for (const { label, selection } of remote) {
        const from = doc.state.body.cursorIndex(selection.from);
        const to = doc.state.body.cursorIndex(selection.to);
        if (from === undefined || to === undefined) { statuses.push({ label, resolved: false }); continue; }
        const end = Math.max(from, to); // A deleted selection collapses instead of inverting.
        statuses.push({ label, resolved: true, from, to: end });
        ranges.push({ label, from: editorOffset(mirror, from), to: editorOffset(mirror, end) });
      }
    } catch (error) { stop(error); }
    dispatch([state.update({ effects: setRemoteRanges.of(ranges) })]);
    options.onRemote?.(statuses);
    return statuses;
  }

  const unsubscribe = doc.state.body.observe((event) => {
    try {
      if (failed) throw failure;
      const next = textEdits(mirror, event);
      mirror = next.mirror;
      if (local) return; // The original editor transaction will be applied once.
      const changes = next.changes.filter(({ from, to, insert }) => state.doc.sliceString(from, to, "\n") !== insert);
      if (changes.length !== 0) dispatch([state.update({ changes, annotations: fromText.of(true) })]);
    } catch (error) { stop(error); }
  });

  return {
    get state() { return state; },
    /** Rebuilt from the editor text and mirror for inspection; linear in the document size. */
    get elements() { return mirrorElements(mirror, state.doc.toString()); },
    dispatch,
    /** The main selection as cursors: a caret binds left; a range keeps edge insertions outside.
     * @returns {CursorSelection} */
    selectionCursors() {
      if (failed) throw failure;
      const { from, to } = state.selection.main;
      const start = elementIndexAt(mirror, from), end = elementIndexAt(mirror, to);
      if (start === end) {
        const caret = doc.state.body.cursorAt(start);
        return { from: caret, to: caret };
      }
      return { from: doc.state.body.cursorAt(start, "right"), to: doc.state.body.cursorAt(end) };
    },
    /** Replaces the remote selections and resolves them against the current Text.
     * @param {readonly RemoteSelection[]} selections */
    setRemote(selections) {
      if (destroyed) throw new Error("Text binding is destroyed");
      if (failed) throw failure;
      remote = selections;
      return resolveRemote();
    },
    destroy() { if (!destroyed) { destroyed = true; unsubscribe(); } },
  };
}
