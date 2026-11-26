// @ts-check
import { EditorState, PluginKey, TextSelection } from "prosemirror-state";
import { buildDoc, flattenDoc, positions, same, textLines } from "./flat.js";
import { editorSchema } from "./schema.js";

/** @typedef {import("../../dist/index.js").Cursor} Cursor */
/** A selection as two cursors; `from === to` is a caret. @typedef {{ readonly from: Cursor, readonly to: Cursor }} CursorSelection */
/** @typedef {import("./flat.js").Line} Line */
/** @typedef {import("../../dist/index.js").JsonValue} JsonValue */
/** @typedef {import("../../dist/index.js").Text<import("./schema.js").NoteMarks, import("./schema.js").NoteBlocks>} NoteText */

const INDENTS = /** @type {const} */ ([1, 2, 3, 4, 5, 6, 7, 8]);

/** Marks transactions the binding makes itself, from the Text: they are not written back to it. */
const fromText = new PluginKey("articollab");

/** The code points of the lines' text, with "\n" between lines. @param {readonly Line[]} lines @returns {string[]} */
function codePoints(lines) {
  /** @type {string[]} */
  const points = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) points.push("\n");
    for (const { text } of line.runs) for (const point of text) points.push(point);
  }
  return points;
}

/** Each code point's marks, with `undefined` for the "\n" between lines. @param {readonly Line[]} lines */
function pointMarks(lines) {
  /** @type {(import("./flat.js").Attributes | undefined)[]} */
  const marks = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) marks.push(undefined);
    for (const run of line.runs) for (const _ of run.text) marks.push(run.marks);
  }
  return marks;
}

/** A text selection near two positions, moved into text where they fall between blocks.
 * @param {import("prosemirror-model").Node} doc @param {number} from @param {number} to */
function textSelection(doc, from, to) {
  return TextSelection.between(doc.resolve(from), doc.resolve(to));
}

/**
 * A transaction that turns `state`'s document into `target` with one replacement of the part that
 * differs, so ProseMirror maps the selection and decorations through it.
 * @param {EditorState} state @param {import("prosemirror-model").Node} target
 */
function replaceWith(state, target) {
  const tr = state.tr.setMeta(fromText, true).setMeta("addToHistory", false);
  const current = state.doc.content;
  const start = current.findDiffStart(target.content);
  if (start === null) return tr;
  const end = current.findDiffEnd(target.content) ?? { a: current.size, b: target.content.size };
  let { a: endA, b: endB } = end;
  // When the change repeats nearby content, the two ends can overlap the start.
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) { endA += overlap; endB += overlap; }
  tr.replace(start, endA, target.slice(start, endB));
  if (tr.doc.eq(target)) return tr;
  // ProseMirror fitted the slice differently: replace everything instead.
  return state.tr.setMeta(fromText, true).setMeta("addToHistory", false).replaceWith(0, current.size, target.content);
}

/** The editor's selection, clamped into `target`. @param {EditorState} editorState @param {import("prosemirror-model").Node} target @returns {[number, number]} */
function clampSelection(editorState, target) {
  const map = positions(flattenDoc(target)), old = positions(flattenDoc(editorState.doc));
  return [map.toPosition(old.toElement(editorState.selection.from)), map.toPosition(old.toElement(editorState.selection.to))];
}

/**
 * Keeps a ProseMirror EditorState and a Text in step. Local transactions are compared with the Text
 * as lines, and the difference is written as one batch of insert, delete, format and formatBlocks.
 * Changes from elsewhere rebuild the document from the Text and replace the part that differs.
 * The editor always shows the standard shape `buildDoc` makes. Runs without a DOM, for tests.
 * @param {{ state: { body: NoteText }, transact(callback: () => void): void, readonly replayConflict: unknown }} doc
 * @param {{ update(state: EditorState): void, canEdit(): boolean, onError(error: unknown): void,
 *   onLocalEdit?(): void, onSelection?(): void, onRemote?(): void,
 *   plugins?: readonly import("prosemirror-state").Plugin[] }} options
 */
export function createRichTextBinding(doc, options) {
  const body = doc.state.body;
  let state = EditorState.create({ schema: editorSchema, doc: buildDoc(editorSchema, textLines(body)), plugins: [...(options.plugins ?? [])] });
  let local = false, destroyed = false, failed = false;
  /** @type {unknown} */
  let failure;

  /** @param {unknown} error @returns {never} */
  function stop(error) {
    if (failed) throw failure;
    failed = true;
    failure = error;
    try { options.onError(error); } catch { /* Reporting a failure must not replace it. */ }
    throw failure;
  }

  /** The selection of `editorState` as cursors; its document must match the Text. @param {EditorState} editorState @returns {CursorSelection} */
  function cursorsOf(editorState) {
    const map = positions(flattenDoc(editorState.doc));
    const start = map.toElement(editorState.selection.from), end = map.toElement(editorState.selection.to);
    if (start === end) {
      const caret = body.cursorAt(start);
      return { from: caret, to: caret };
    }
    return { from: body.cursorAt(start, "right"), to: body.cursorAt(end) };
  }
  /** Kept current, so a change from elsewhere can put the selection back on the same text. */
  let selection = cursorsOf(state);

  /** @param {"bold" | "italic" | "code" | "link"} key @param {number} index @param {number} count @param {JsonValue | undefined} value */
  function format(key, index, count, value) {
    if (key === "link") body.format(index, count, key, typeof value === "string" ? value : null);
    else body.format(index, count, key, value === true ? true : null);
  }
  /** @param {string} key @param {number} index @param {JsonValue | undefined} value */
  function formatBlock(key, index, value) {
    switch (key) {
      case "heading": body.formatBlocks(index, 0, key, value === 1 || value === 2 || value === 3 ? value : null); break;
      case "list": body.formatBlocks(index, 0, key, value === "bullet" || value === "ordered" ? value : null); break;
      case "indent": body.formatBlocks(index, 0, key, INDENTS.find((indent) => indent === value) ?? null); break;
      case "quote": case "code": body.formatBlocks(index, 0, key, value === true ? true : null); break;
      default: break;
    }
  }

  /** Writes the difference between the Text and `lines` as one batch. @param {readonly Line[]} lines */
  function write(lines) {
    doc.transact(() => {
      const before = codePoints(textLines(body)), after = codePoints(lines);
      let prefix = 0;
      while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
      let suffix = 0;
      while (suffix < before.length - prefix && suffix < after.length - prefix &&
        before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
      if (before.length - prefix - suffix > 0) body.delete(prefix, before.length - prefix - suffix);
      if (after.length - prefix - suffix > 0) body.insert(prefix, after.slice(prefix, after.length - suffix).join(""));

      // Marks: one format per run whose value differs from what the Text now has.
      const want = pointMarks(lines), have = pointMarks(textLines(body));
      for (const key of /** @type {const} */ (["bold", "italic", "code", "link"])) {
        for (let index = 0; index < want.length;) {
          const wanted = want[index]?.[key], had = have[index]?.[key];
          if (want[index] === undefined || same(wanted ?? null, had ?? null)) { index++; continue; }
          let end = index + 1;
          while (end < want.length && want[end] !== undefined && same(want[end]?.[key] ?? null, wanted ?? null) &&
            !same(have[end]?.[key] ?? null, wanted ?? null)) end++;
          format(key, index, end - index, wanted);
          index = end;
        }
      }

      // Paragraph attributes: each line against the Text's paragraph at the same position.
      const blocks = body.blocks();
      for (const [index, line] of lines.entries()) {
        const block = blocks[index];
        if (block === undefined) continue;
        for (const key of new Set([...Object.keys(line.attributes), ...Object.keys(block.attributes)])) {
          const value = line.attributes[key];
          if (!same(value ?? null, /** @type {Record<string, unknown>} */ (block.attributes)[key] ?? null)) formatBlock(key, block.index, value);
        }
      }
    });
  }

  /** @param {readonly import("prosemirror-state").Transaction[]} transactions */
  function dispatch(...transactions) {
    if (destroyed) throw new Error("Rich text binding is destroyed");
    for (const tr of transactions) {
      if (tr.getMeta(fromText) === true || !tr.docChanged) {
        state = state.apply(tr);
        if (tr.selectionSet && !tr.docChanged) selection = cursorsOf(state);
        options.update(state);
        if (tr.selectionSet) options.onSelection?.();
        continue;
      }
      if (failed) throw failure;
      // Busy is a precondition, not a failure: the edit is dropped and the editor keeps its state.
      if (!options.canEdit() || doc.replayConflict !== null) continue;
      try {
        const next = state.apply(tr);
        local = true;
        try { write(flattenDoc(next.doc).lines); } finally { local = false; }
        state = next;
        // Show the standard shape, such as one paragraph per list item.
        const standard = buildDoc(editorSchema, textLines(body));
        if (!standard.eq(state.doc)) {
          const [from, to] = clampSelection(state, standard);
          const fix = replaceWith(state, standard);
          state = state.apply(fix.setSelection(textSelection(fix.doc, from, to)));
        }
        selection = cursorsOf(state);
        options.update(state);
      } catch (error) { stop(error); }
      options.onLocalEdit?.();
      options.onSelection?.();
    }
  }

  /** Changes from elsewhere: other writers, undo, or a rolled back edit. */
  const unsubscribe = body.observe(() => {
    if (local || destroyed) return;
    try {
      if (failed) throw failure;
      const tr = replaceWith(state, buildDoc(editorSchema, textLines(body)));
      const range = resolve(selection, tr.doc);
      if (range !== undefined) tr.setSelection(textSelection(tr.doc, range.from, range.to));
      state = state.apply(tr);
      options.update(state);
      options.onRemote?.();
    } catch (error) { stop(error); }
  });

  /** A selection's current positions in `editorDoc`, or undefined while an anchor is unknown here.
   * @param {CursorSelection} cursors @param {import("prosemirror-model").Node} editorDoc */
  function resolve(cursors, editorDoc) {
    const from = body.cursorIndex(cursors.from), to = body.cursorIndex(cursors.to);
    if (from === undefined || to === undefined) return undefined;
    const map = positions(flattenDoc(editorDoc));
    // A deleted selection collapses instead of inverting.
    return { from: map.toPosition(Math.min(from, to)), to: map.toPosition(Math.max(from, to)) };
  }

  return {
    get state() { return state; },
    dispatch,
    /** The main selection as cursors. @returns {CursorSelection} */
    selectionCursors() { return selection; },
    /** Another writer's selection in the editor's positions. @param {CursorSelection} cursors */
    resolve(cursors) { return resolve(cursors, state.doc); },
    destroy() { if (!destroyed) { destroyed = true; unsubscribe(); } },
  };
}
