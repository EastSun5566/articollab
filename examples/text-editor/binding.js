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

/** @typedef {Readonly<Record<string, import("../../dist/index.js").JsonValue>>} Attributes */
/** A formatted run in UTF-16 offsets. @typedef {{ readonly from: number, readonly to: number, readonly attributes: Attributes }} FormatRange */

/** Replaces the marks of each run, in the offsets of the transaction's new document.
 * @type {import("@codemirror/state").StateEffectType<readonly FormatRange[]>} */
const setFormats = StateEffect.define();

/** @param {readonly FormatRange[]} ranges @param {readonly FormatRange[]} runs @returns {readonly FormatRange[]} */
function applyFormats(ranges, runs) {
  let result = [...ranges];
  for (const run of runs) {
    /** @type {FormatRange[]} */
    const next = [];
    for (const range of result) {
      if (range.to <= run.from || range.from >= run.to) { next.push(range); continue; }
      if (range.from < run.from) next.push({ ...range, to: run.from });
      if (range.to > run.to) next.push({ ...range, from: run.to });
    }
    if (Object.keys(run.attributes).length !== 0) next.push(run);
    result = next.toSorted((left, right) => left.from - right.from);
  }
  // Join touching runs with the same marks; the Text sorts attribute keys, so JSON compares them.
  return result.reduce((/** @type {FormatRange[]} */ joined, range) => {
    const last = joined.at(-1);
    if (last !== undefined && last.to === range.from && JSON.stringify(last.attributes) === JSON.stringify(range.attributes)) {
      joined[joined.length - 1] = { ...last, to: range.to };
    } else joined.push(range);
    return joined;
  }, []);
}

/** Formatted runs, for decorations. Text inserted at a run's edge is outside it until the Text's
 * format event says otherwise, which the binding applies right after the edit. */
export const formatRanges = StateField.define({
  /** @returns {readonly FormatRange[]} */
  create: () => [],
  update(ranges, transaction) {
    let next = !transaction.docChanged ? ranges : ranges.flatMap((range) => {
      const from = transaction.changes.mapPos(range.from, 1), to = transaction.changes.mapPos(range.to, -1);
      return from < to ? [{ ...range, from, to }] : [];
    });
    for (const effect of transaction.effects) if (effect.is(setFormats)) next = applyFormats(next, effect.value);
    return next;
  },
});

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
 * @param {{state: {body: import("../../dist/index.js").Text<import("./schema.js").NoteMarks>},
 *   transact: (callback: () => void) => void, readonly replayConflict: unknown}} doc
 * @param {{update: (transactions: readonly import("@codemirror/state").Transaction[]) => void,
 *   canEdit: () => boolean, onError: (error: unknown) => void,
 *   onLocalEdit?: () => void, extensions?: import("@codemirror/state").Extension,
 *   onSelection?: () => void, onRemote?: (statuses: readonly RemoteStatus[]) => void}} options
 */
export function createTextBinding(doc, options) {
  let mirror = createMirror(doc.state.body);
  /** @type {FormatRange[]} */
  const initial = [];
  let position = 0;
  for (const { insert, attributes } of doc.state.body.toDelta()) {
    if (attributes !== undefined) initial.push({ from: position, to: position + insert.length, attributes });
    position += insert.length;
  }
  let state = EditorState.create({ doc: doc.state.body.toString(), extensions: [
    EditorState.lineSeparator.of("\n"), remoteRanges, formatRanges.init(() => initial), options.extensions ?? [],
  ] });
  /** Marks of this writer's own typing, applied once its editor transaction is. @type {FormatRange[]} */
  let localFormats = [];
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
      // Marks from an earlier transaction of this batch are in its offsets.
      if (transaction.docChanged && localFormats.length !== 0) {
        localFormats = localFormats.map((range) => ({ ...range,
          from: transaction.changes.mapPos(range.from, 1), to: transaction.changes.mapPos(range.to, -1) }));
      }
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
    if (localFormats.length !== 0) {
      const effects = setFormats.of(localFormats);
      localFormats = [];
      dispatch([state.update({ effects })]);
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
      const formats = (event.formats ?? []).map(({ index, count, attributes }) => ({
        from: editorOffset(mirror, index), to: editorOffset(mirror, index + count), attributes,
      }));
      if (local) { localFormats.push(...formats); return; } // The original editor transaction will be applied once.
      const changes = next.changes.filter(({ from, to, insert }) => state.doc.sliceString(from, to, "\n") !== insert);
      if (changes.length !== 0 || formats.length !== 0) {
        dispatch([state.update({ changes, effects: setFormats.of(formats), annotations: fromText.of(true) })]);
      }
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
    /** Sets `key` to `value` on the selected text, or removes it if the whole selection already has that value.
     * @param {keyof import("./schema.js").NoteMarks} key @param {string | true} value
     * @returns {boolean} whether there was a selection to format */
    toggleMark(key, value) {
      if (destroyed) throw new Error("Text binding is destroyed");
      if (failed) throw failure;
      const { from, to } = state.selection.main;
      const start = elementIndexAt(mirror, from), end = elementIndexAt(mirror, to);
      if (start === end) return false;
      let everywhere = true;
      for (let index = start; index < end && everywhere; index++) everywhere = doc.state.body.attributesAt(index)[key] === value;
      doc.state.body.format(start, end - start, key, everywhere ? null : value);
      return true;
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
