// @ts-check
import { Annotation, ChangeSet, EditorState, StateEffect, StateField } from "@codemirror/state";
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

/** A line's paragraph attributes, by the offset where the line starts. @typedef {{ readonly from: number, readonly attributes: Attributes }} BlockLine */

/** Replaces the attributes of each line that starts at `from`, in the offsets of the transaction's new document.
 * @type {import("@codemirror/state").StateEffectType<readonly BlockLine[]>} */
const setBlocks = StateEffect.define();

/** Installs the formatted projection when the composing view catches up.
 * @type {import("@codemirror/state").StateEffectType<{formats: readonly FormatRange[], blocks: readonly BlockLine[]}>} */
const restoreFormatting = StateEffect.define();

/** Lines with paragraph attributes, for line decorations. A line that an edit joins to the one before it loses its entry. */
export const blockLines = StateField.define({
  /** @returns {readonly BlockLine[]} */
  create: () => [],
  update(lines, transaction) {
    for (const effect of transaction.effects) if (effect.is(restoreFormatting)) return effect.value.blocks;
    /** @type {Map<number, Attributes>} */
    const next = new Map();
    for (const line of lines) {
      const from = transaction.docChanged ? transaction.changes.mapPos(line.from, -1) : line.from;
      if (transaction.state.doc.lineAt(from).from === from) next.set(from, line.attributes);
    }
    for (const effect of transaction.effects) {
      if (!effect.is(setBlocks)) continue;
      for (const { from, attributes } of effect.value) {
        if (Object.keys(attributes).length === 0) next.delete(from);
        else next.set(from, attributes);
      }
    }
    return [...next].map(([from, attributes]) => ({ from, attributes })).toSorted((left, right) => left.from - right.from);
  },
});

/** Formatted runs, for decorations. Text inserted at a run's edge is outside it until the Text's
 * format event says otherwise, which the binding applies right after the edit. */
export const formatRanges = StateField.define({
  /** @returns {readonly FormatRange[]} */
  create: () => [],
  update(ranges, transaction) {
    for (const effect of transaction.effects) if (effect.is(restoreFormatting)) return effect.value.formats;
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
 * @param {{state: {body: import("../../dist/index.js").Text<import("./schema.js").NoteMarks, import("./schema.js").NoteBlocks>},
 *   transact: (callback: () => void) => void, readonly replayConflict: unknown}} doc
 * @param {{update: (transactions: readonly import("@codemirror/state").Transaction[]) => void,
 *   canEdit: () => boolean, onError: (error: unknown) => void,
 *   onLocalEdit?: () => void, onCompositionBoundary?: () => void, onUnsentComposition?: (text: string) => void,
 *   extensions?: import("@codemirror/state").Extension,
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
  const initialLines = doc.state.body.blocks().filter(({ attributes }) => Object.keys(attributes).length !== 0)
    .map(({ index, attributes }) => ({ from: editorOffset(mirror, index), attributes }));
  let state = EditorState.create({ doc: doc.state.body.toString(), extensions: [
    EditorState.lineSeparator.of("\n"), remoteRanges, formatRanges.init(() => initial), blockLines.init(() => initialLines),
    options.extensions ?? [],
  ] });
  /** Marks and paragraphs of this writer's own typing, applied once its editor transaction is. @type {FormatRange[]} */
  let localFormats = [];
  /** @type {BlockLine[]} */
  let localBlocks = [];
  /** @type {readonly RemoteSelection[]} */
  let remote = [];
  let local = false, destroyed = false, failed = false;
  /** @type {{base: EditorState, shared: EditorState, draft: ChangeSet, incoming: ChangeSet} | undefined} */
  let composition;
  /** @type {unknown} */
  let failure;
  /** @param {unknown} error @returns {never} */
  function stop(error) {
    if (failed) throw failure;
    failed = true;
    composition = undefined;
    failure = error;
    try { options.onError(error); }
    catch { /* Reporting a failure must not replace it. */ }
    throw failure;
  }

  /** @param {ReturnType<typeof editorEdits>} edits */
  function writeEdits(edits) {
    if (edits.length === 0) return;
    local = true;
    try {
      doc.transact(() => {
        for (const edit of edits) {
          if (edit.deleteCount !== 0) doc.state.body.delete(edit.index, edit.deleteCount);
          if (edit.insert !== "") doc.state.body.insert(edit.index, edit.insert);
        }
      });
    } finally { local = false; }
  }

  function takeLocalFormatting() {
    const effects = [setFormats.of(localFormats), setBlocks.of(localBlocks)];
    localFormats = [];
    localBlocks = [];
    return effects;
  }

  /** @param {readonly import("@codemirror/state").Transaction[]} transactions */
  function dispatch(transactions) {
    if (destroyed) throw new Error("Text binding is destroyed");
    let docChanged = false, moved = false;
    for (const transaction of transactions) {
      if (transaction.startState !== state) stop(new Error("Stale editor transaction"));
      if (transaction.docChanged && failed) throw failure;
      if (composition !== undefined) {
        try {
          if (transaction.docChanged) composition.draft = composition.draft.compose(transaction.changes);
          state = transaction.state;
          options.update([transaction]);
        } catch (error) { stop(error); }
        continue;
      }
      docChanged ||= transaction.docChanged;
      moved ||= transaction.docChanged || transaction.selection !== undefined;
      // Marks from an earlier transaction of this batch are in its offsets.
      if (transaction.docChanged && localFormats.length !== 0) {
        localFormats = localFormats.map((range) => ({ ...range,
          from: transaction.changes.mapPos(range.from, 1), to: transaction.changes.mapPos(range.to, -1) }));
      }
      if (transaction.docChanged && localBlocks.length !== 0) {
        localBlocks = localBlocks.map((line) => ({ ...line, from: transaction.changes.mapPos(line.from, -1) }));
      }
      const external = transaction.annotation(fromText) === true;
      // Busy is a precondition, not a permanent failure of an in-flight sync.
      if (transaction.docChanged && !external && (!options.canEdit() || doc.replayConflict !== null)) {
        throw new Error("Editor is read-only");
      }
      try {
        if (transaction.docChanged && !external) {
          const edits = editorEdits(mirror, transaction);
          writeEdits(edits);
          if (edits.length !== 0) options.onLocalEdit?.();
        }
        state = transaction.state;
        options.update([transaction]);
      } catch (error) { stop(error); }
    }
    if (localFormats.length !== 0 || localBlocks.length !== 0) {
      dispatch([state.update({ effects: takeLocalFormatting() })]);
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
      const blocks = (event.blocks ?? []).map(({ index, attributes }) => ({ from: editorOffset(mirror, index), attributes }));
      // The original editor transaction will be applied once.
      if (local) { localFormats.push(...formats); localBlocks.push(...blocks); return; }
      const shared = composition?.shared ?? state;
      const changes = next.changes.filter(({ from, to, insert }) => shared.doc.sliceString(from, to, "\n") !== insert);
      if (changes.length !== 0 || formats.length !== 0 || blocks.length !== 0) {
        const transaction = shared.update({ changes, effects: [setFormats.of(formats), setBlocks.of(blocks)],
          annotations: fromText.of(true) });
        if (composition === undefined) dispatch([transaction]);
        else {
          composition.shared = transaction.state;
          composition.incoming = composition.incoming.compose(transaction.changes);
        }
      }
    } catch (error) { stop(error); }
  });

  return {
    get state() { return state; },
    /** Rebuilt from the editor text and mirror for inspection; linear in the document size. */
    get elements() { return mirrorElements(mirror, state.doc.toString()); },
    dispatch,
    get composing() { return composition !== undefined; },
    startComposition() {
      if (composition !== undefined || destroyed || failed || !options.canEdit() || doc.replayConflict !== null) return;
      const empty = ChangeSet.empty(state.doc.length);
      composition = { base: state, shared: state, draft: empty, incoming: empty };
    },
    finishComposition(cancelled = false) {
      const completed = composition;
      if (completed === undefined || destroyed || failed) return;
      try {
        const { base, shared, draft, incoming } = completed;
        /** @type {import("@codemirror/state").ChangeSpec[]} */
        const changed = [];
        draft.iterChanges((from, to, _from, _to, insert) => {
          if (!base.doc.slice(from, to).eq(insert)) changed.push({ from, to, insert });
        });
        const net = base.changes(changed);
        const allowed = options.canEdit() && doc.replayConflict === null;
        const discardDraft = cancelled || !allowed;
        const translated = discardDraft ? undefined : shared.update({ changes: net.map(incoming) });
        const edits = translated === undefined ? [] : editorEdits(mirror, translated);
        let final = shared;
        if (translated !== undefined && edits.length !== 0) {
          options.onCompositionBoundary?.();
          writeEdits(edits);
          options.onCompositionBoundary?.();
          final = translated.state.update({ effects: takeLocalFormatting() }).state;
        }
        // Both views receive the same changes, with already received remote inserts ordered first.
        const changes = discardDraft ? draft.invert(base.doc).compose(incoming) : incoming.map(net, true);
        composition = undefined;
        const transaction = state.update({
          changes, selection: state.selection.map(changes),
          effects: restoreFormatting.of({ formats: final.field(formatRanges), blocks: final.field(blockLines) }),
          annotations: fromText.of(true),
        });
        state = transaction.state;
        options.update([transaction]);
        if (!cancelled && !allowed && !net.empty) {
          /** @type {string[]} */
          const unsent = [];
          net.iterChanges((from, to, _from, _to, insert) => {
            unsent.push(insert.length === 0 ? "Delete: " + base.doc.sliceString(from, to) : insert.toString());
          });
          options.onUnsentComposition?.(unsent.join("\n"));
        }
        if (edits.length !== 0) options.onLocalEdit?.();
        if (remote.length !== 0) resolveRemote();
        options.onSelection?.();
      } catch (error) { stop(error); }
    },
    /** The main selection as cursors: a caret binds left; a range keeps edge insertions outside.
     * @returns {CursorSelection} */
    selectionCursors() {
      if (failed) throw failure;
      if (composition !== undefined) throw new Error("Cannot share a draft selection");
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
      if (composition !== undefined) return false;
      const { from, to } = state.selection.main;
      const start = elementIndexAt(mirror, from), end = elementIndexAt(mirror, to);
      if (start === end) return false;
      let everywhere = true;
      for (let index = start; index < end && everywhere; index++) everywhere = doc.state.body.attributesAt(index)[key] === value;
      doc.state.body.format(start, end - start, key, everywhere ? null : value);
      return true;
    },
    /** Sets a paragraph attribute on the paragraphs the selection touches, or removes it if they all have it.
     * @param {{ key: "heading", value: 1 | 2 } | { key: "list", value: "bullet" }} attribute */
    toggleBlock(attribute) {
      if (destroyed) throw new Error("Text binding is destroyed");
      if (failed) throw failure;
      if (composition !== undefined) return;
      const { from, to } = state.selection.main;
      const start = elementIndexAt(mirror, from), end = elementIndexAt(mirror, to);
      const touched = doc.state.body.blocks().filter((block) => block.index + block.length >= start &&
        (start === end ? block.index <= start : block.index < end));
      const everywhere = touched.every(({ attributes }) => attributes[attribute.key] === attribute.value);
      if (attribute.key === "heading") doc.state.body.formatBlocks(start, end - start, "heading", everywhere ? null : attribute.value);
      else doc.state.body.formatBlocks(start, end - start, "list", everywhere ? null : attribute.value);
    },
    /**
     * Enter: a new paragraph. In a list item it continues the list; in an empty one it ends the list instead.
     * At the start of a paragraph, the paragraph's attributes move down with its text, since they belong
     * to the line break that starts it, which now starts the empty paragraph above.
     * @returns {boolean} whether it handled the key
     */
    enter() {
      if (destroyed || failed || composition !== undefined || !options.canEdit() || doc.replayConflict !== null) return false;
      const { from, to } = state.selection.main;
      const start = elementIndexAt(mirror, from);
      const block = doc.state.body.blocks().find((entry) => entry.index <= start && start <= entry.index + entry.length);
      const list = block?.attributes.list;
      if (list !== undefined && block !== undefined && block.length === 0 && from === to) {
        doc.state.body.formatBlocks(start, 0, "list", null);
        return true;
      }
      const atStart = block !== undefined && from === to && start === block.index && block.length !== 0;
      dispatch([state.update({ changes: { from, to, insert: "\n" }, selection: { anchor: from + 1 }, userEvent: "input" })]);
      const next = elementIndexAt(mirror, from + 1);
      if (atStart && block.attributes.heading !== undefined) {
        doc.state.body.formatBlocks(next, 0, "heading", block.attributes.heading);
        doc.state.body.formatBlocks(start, 0, "heading", null);
      }
      if (list !== undefined) doc.state.body.formatBlocks(next, 0, "list", list);
      return true;
    },
    /** Replaces the remote selections and resolves them against the current Text.
     * @param {readonly RemoteSelection[]} selections */
    setRemote(selections) {
      if (destroyed) throw new Error("Text binding is destroyed");
      if (failed) throw failure;
      remote = selections;
      return composition === undefined ? resolveRemote() : [];
    },
    destroy() { if (!destroyed) { destroyed = true; composition = undefined; unsubscribe(); } },
  };
}
