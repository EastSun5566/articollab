import { Fragment, type Node, type Schema } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import type { ClientDocument, Cursor, JsonValue, SchemaShape, TextChangeEvent, TextSchema, UndoManager } from "../index.ts";
import { basicMapping, lineLength, sameJson, TextShape, textLines, type Attributes, type Line, type TextMapping } from "./mapping.ts";

/** A selection as two cursors; `from === to` is a caret. */
export interface CursorSelection {
  readonly from: Cursor;
  readonly to: Cursor;
}

/** The part of a Text the binding reads and writes. */
interface SyncedText {
  readonly length: number;
  insert(index: number, value: string): void;
  delete(index: number, count?: number): void;
  format(index: number, count: number, key: string, value: JsonValue | null): void;
  formatBlocks(index: number, count: number, key: string, value: JsonValue | null): void;
  toDelta(index?: number, count?: number): readonly { readonly insert: string; readonly attributes?: Attributes }[];
  blocks(index?: number, count?: number): readonly { readonly index: number; readonly length: number; readonly attributes: Attributes }[];
  cursorAt(index: number, bind?: "left" | "right"): Cursor;
  cursorIndex(cursor: Cursor): number | undefined;
  observe(listener: (event: TextChangeEvent) => void): () => void;
}

/** The document a binding writes through: its Text, transactions and replay state. */
interface SyncedDocument {
  readonly state: Readonly<Record<string, unknown>>;
  transact(callback: () => void): void;
  readonly replayConflict: unknown;
}

export interface TextSyncOptions {
  /** Which nodes and marks stand for the Text's lines; `basicMapping` by default. */
  readonly mapping?: TextMapping;
  /** Ends an undo step around a confirmed input method composition, so it is a step of its own. */
  readonly history?: UndoManager;
  /** Whether local edits may be written now; an edit is refused while it returns false. */
  readonly canEdit?: () => boolean;
  /** Called with an error that stopped the binding; local edits are refused from then on. */
  readonly onError?: (error: unknown) => void;
  /** Called with the text of a composition that could not be written, for the user to copy. */
  readonly onUnsentComposition?: (text: string) => void;
}

/** Paths of a schema whose collection is a Text. */
export type TextPath<S extends SchemaShape> = { [K in keyof S & string]: S[K] extends TextSchema ? K : never }[keyof S & string];

const syncKey = new PluginKey<SyncState>("articollab-text-sync");

/** The plugin's state: its binding, and whether the latest transaction came from the Text. */
interface SyncState {
  readonly binding: TextBinding;
  readonly fromText: boolean;
}

/** The code points of some lines, with "\n" between them. */
function codePoints(lines: readonly Line[]): string[] {
  const points: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) points.push("\n");
    for (const { text } of line.runs) for (const point of text) points.push(point);
  }
  return points;
}

/** Each code point's marks, with `undefined` for the "\n" between lines. */
function pointMarks(lines: readonly Line[]): (Attributes | undefined)[] {
  const marks: (Attributes | undefined)[] = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) marks.push(undefined);
    for (const run of line.runs) for (const _ of run.text) marks.push(run.marks);
  }
  return marks;
}

/** The one replacement that turns `before` into `after`: `count` code points from `index` become `insert`. */
function splice(before: readonly string[], after: readonly string[]) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { index: prefix, count: before.length - prefix - suffix, insert: after.slice(prefix, after.length - suffix) };
}

/** The length in elements of some lines joined by line breaks. */
function textLength(lines: readonly Line[]): number {
  return lines.reduce((sum, line) => sum + lineLength(line), 0) + Math.max(0, lines.length - 1);
}

/**
 * The top-level children that differ between two documents, with one unchanged neighbor on each
 * side: `[from, toA)` in `a` and `[from, toB)` in `b`. Rebuilding such a window can never call for
 * a merge with a node outside it, since its neighbors' edge lines did not change.
 */
function changedWindow(a: Node, b: Node): { from: number; toA: number; toB: number } | undefined {
  const start = a.content.findDiffStart(b.content);
  if (start === null) return undefined;
  const end = a.content.findDiffEnd(b.content) ?? { a: a.content.size, b: b.content.size };
  let endA = end.a, endB = end.b;
  // When the change repeats nearby content, the two ends can overlap the start.
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) { endA += overlap; endB += overlap; }
  const after = (doc: Node, position: number) => {
    const resolved = doc.resolve(position);
    return resolved.depth === 0 ? resolved.index(0) : resolved.index(0) + 1;
  };
  const first = Math.min(a.resolve(start).index(0), after(a, endA), after(b, endB));
  return {
    from: Math.max(0, first - 1),
    toA: Math.min(a.childCount, after(a, endA) + 1),
    toB: Math.min(b.childCount, after(b, endB) + 1),
  };
}

/** Keeps one editor and one Text in step; created when the plugin's view starts. */
export class TextBinding {
  readonly shape: TextShape;
  private readonly text: SyncedText;
  private readonly doc: SyncedDocument;
  private readonly options: TextSyncOptions;
  private view: EditorView | undefined;
  private stop: (() => void) | undefined;
  /** True while this binding writes, so its own changes are not applied back. */
  private writing = false;
  private failure: { error: unknown } | undefined;
  /** The selection as cursors, kept current so a change from elsewhere can put it back on the same text. */
  selection: CursorSelection | undefined;
  private composition: {
    readonly base: Node; readonly from: number; readonly gaps: readonly { left: Cursor; right: Cursor }[];
    readonly selection: CursorSelection | undefined; incoming: boolean; cancelled: boolean;
  } | undefined;
  private ending: ReturnType<typeof setTimeout> | undefined;

  constructor(doc: SyncedDocument, text: SyncedText, schema: Schema, options: TextSyncOptions) {
    this.doc = doc;
    this.text = text;
    this.options = options;
    this.shape = new TextShape(schema, options.mapping ?? basicMapping);
  }

  get failed(): boolean { return this.failure !== undefined; }
  get composing(): boolean { return this.composition !== undefined; }
  /** Whether a composition that ended waits to be written. */
  get finishing(): boolean { return this.ending !== undefined; }

  /** Whether a local edit may be written now. */
  canWrite(): boolean {
    return !this.failed && (this.options.canEdit?.() ?? true) && this.doc.replayConflict === null;
  }

  private fail(error: unknown): never {
    if (this.failure === undefined) {
      this.failure = { error };
      this.composition = undefined;
      try { this.options.onError?.(error); } catch { /* Reporting a failure must not replace it. */ }
    }
    throw this.failure.error;
  }

  attach(view: EditorView): void {
    this.view = view;
    this.stop = this.text.observe((event) => { this.received(event); });
    // Show the Text if the editor started from something else.
    const standard = this.shape.doc(textLines(this.text));
    if (!standard.eq(view.state.doc)) this.show(view, standard);
    else this.selection = this.cursorsOf(view.state);
  }

  detach(): void {
    this.stop?.();
    this.stop = undefined;
    this.view = undefined;
    this.composition = undefined;
    clearTimeout(this.ending);
  }

  /** The selection of `state` as cursors; its document must show the Text. */
  cursorsOf(state: Pick<EditorState, "doc" | "selection">): CursorSelection {
    const start = this.shape.elementAt(state.doc, state.selection.from), end = this.shape.elementAt(state.doc, state.selection.to);
    if (start === end) {
      const caret = this.text.cursorAt(start);
      return { from: caret, to: caret };
    }
    return { from: this.text.cursorAt(start, "right"), to: this.text.cursorAt(end) };
  }

  /** A selection's current positions in `doc`, or undefined while an anchor is unknown here. */
  resolve(cursors: CursorSelection, doc: Node): { from: number; to: number } | undefined {
    const from = this.text.cursorIndex(cursors.from), to = this.text.cursorIndex(cursors.to);
    if (from === undefined || to === undefined) return undefined;
    // A deleted selection collapses instead of inverting.
    return { from: this.shape.positionAt(doc, Math.min(from, to)), to: this.shape.positionAt(doc, Math.max(from, to)) };
  }

  /** Replaces the editor's document with `target`, keeping the selection on the same text. */
  private show(view: EditorView, target: Node): void {
    const tr = view.state.tr;
    if (!target.eq(tr.doc)) tr.replaceWith(0, tr.doc.content.size, target.content);
    this.restoreSelection(tr);
    view.dispatch(tr.setMeta(syncKey, "text").setMeta("addToHistory", false));
  }

  private restoreSelection(tr: Transaction): void {
    const range = this.selection === undefined ? undefined : this.resolve(this.selection, tr.doc);
    if (range !== undefined) tr.setSelection(TextSelection.between(tr.doc.resolve(range.from), tr.doc.resolve(range.to)));
    this.selection = this.cursorsOf(tr);
  }

  // Local edits.

  /** Formats `want` from `offset` where the Text's marks there now, `have`, differ: one format per run. */
  private formatRuns(want: readonly (Attributes | undefined)[], have: readonly (Attributes | undefined)[], offset: number): void {
    for (const key of Object.keys(this.shape.mapping.marks)) {
      for (let index = 0; index < want.length;) {
        const wanted = want[index]?.[key], had = have[index]?.[key];
        if (want[index] === undefined || sameJson(wanted ?? null, had ?? null)) { index++; continue; }
        let end = index + 1;
        while (end < want.length && want[end] !== undefined && sameJson(want[end]?.[key] ?? null, wanted ?? null) &&
          !sameJson(have[end]?.[key] ?? null, wanted ?? null)) end++;
        this.text.format(offset + index, end - index, key, wanted ?? null);
        index = end;
      }
    }
  }

  /** Writes `after` over the Text's `before` lines at element `offset`, in the current transaction. */
  private writeLines(offset: number, before: readonly Line[], after: readonly Line[]): void {
    const change = splice(codePoints(before), codePoints(after));
    if (change.count > 0) this.text.delete(offset + change.index, change.count);
    if (change.insert.length > 0) this.text.insert(offset + change.index, change.insert.join(""));
    const now = textLines(this.text, offset, textLength(after));
    this.formatRuns(pointMarks(after), pointMarks(now), offset);
    // Paragraph attributes: each line against the Text's line at the same place.
    let start = offset;
    for (const [index, line] of after.entries()) {
      const have = now[index]?.attributes ?? {};
      for (const key of new Set([...Object.keys(line.attributes), ...Object.keys(have)])) {
        const value = line.attributes[key];
        if (!sameJson(value ?? null, have[key] ?? null)) this.text.formatBlocks(start, 0, key, value ?? null);
      }
      start += lineLength(line) + 1;
    }
  }

  /** The lines of children `[from, to)` of `doc`. */
  private windowLines(doc: Node, from: number, to: number): Line[] {
    const lines: Line[] = [];
    for (let index = from; index < to; index++) lines.push(...this.shape.nodeLines(doc.child(index)));
    return lines;
  }

  /** The Text element where children `[from, …)` of `doc` start: their first line's. */
  private windowStart(doc: Node, from: number, to: number): number | undefined {
    const layout = this.shape.layout(doc);
    for (let index = from; index < to; index++) if (layout.lined.includes(index)) return layout.elements[index];
    return undefined;
  }

  /** Writes the change from `before` to `after`, which shows `before` plus local edits, as one batch. */
  write(before: Node, after: Node): void {
    const window = changedWindow(before, after);
    if (window === undefined) return;
    let oldLines = this.windowLines(before, window.from, window.toA);
    let newLines = this.windowLines(after, window.from, window.toB);
    let offset = this.windowStart(before, window.from, window.toA);
    if (offset === undefined || oldLines.length === 0 || newLines.length === 0) {
      // A window that has no lines on one side: write the whole document.
      oldLines = this.shape.lines(before);
      newLines = this.shape.lines(after);
      offset = 0;
    }
    this.writing = true;
    try { this.doc.transact(() => { this.writeLines(offset, oldLines, newLines); }); }
    finally { this.writing = false; }
  }

  /** The standard shape of what changed from `before` to `after`, or undefined when already standard. */
  standardize(before: Node, after: Node, tr: Transaction): Transaction | undefined {
    const window = changedWindow(before, after);
    if (window === undefined) return undefined;
    const lines = this.windowLines(after, window.from, window.toB);
    const whole = window.from === 0 && window.toB === after.childCount;
    const nodes = lines.length === 0 ? (whole ? this.shape.doc([]).content : undefined) : Fragment.from(this.shape.nodes(lines));
    // A window without lines inside a larger document: the neighbors' lines decide; rebuild it all.
    const standard = nodes ?? this.shape.doc(this.shape.lines(after)).content;
    const fromPos = nodes === undefined ? 0 : this.shape.layout(after).positions[window.from] ?? 0;
    const toPos = nodes === undefined ? after.content.size
      : window.toB < after.childCount ? this.shape.layout(after).positions[window.toB]! : after.content.size;
    if (after.slice(fromPos, toPos).content.eq(standard)) return undefined;
    // The lines stay the same, so the selection keeps its elements.
    const head = this.shape.elementAt(after, tr.selection.head), anchor = this.shape.elementAt(after, tr.selection.anchor);
    tr.replaceWith(fromPos, toPos, standard);
    tr.setSelection(TextSelection.between(tr.doc.resolve(this.shape.positionAt(tr.doc, anchor)), tr.doc.resolve(this.shape.positionAt(tr.doc, head))));
    return tr.setMeta(syncKey, "standard").setMeta("addToHistory", false);
  }

  /** After a local transaction: writes it to the Text. */
  updated(view: EditorView, previous: EditorState): void {
    if (this.composing || this.failed) return;
    const state = view.state;
    if (syncKey.getState(state)?.fromText === true) return;
    if (previous.doc !== state.doc) {
      try { this.write(previous.doc, state.doc); } catch (error) { this.fail(error); }
    }
    if (previous.doc !== state.doc || !previous.selection.eq(state.selection)) this.selection = this.cursorsOf(state);
  }

  // Changes from elsewhere.

  private received(event: TextChangeEvent): void {
    const view = this.view;
    if (this.writing || view === undefined || this.failed) return;
    if (this.composition !== undefined) { this.composition.incoming = true; return; }
    try { this.apply(view, event); } catch (error) { this.fail(error); }
  }

  /** Rebuilds just the top-level nodes an event touched, with one neighbor on each side. */
  private apply(view: EditorView, event: TextChangeEvent): void {
    const doc = view.state.doc;
    const delta = event.afterLength - event.beforeLength;
    let start = Infinity, endPre = -Infinity, endPost = -Infinity;
    for (const { index, deleteCount } of event.changes) {
      start = Math.min(start, index);
      endPre = Math.max(endPre, index + deleteCount);
    }
    if (endPre > -Infinity) endPost = endPre + delta;
    for (const { index, count } of event.formats ?? []) { start = Math.min(start, index); endPost = Math.max(endPost, index + count); }
    for (const { index } of event.blocks ?? []) { start = Math.min(start, index); endPost = Math.max(endPost, index); }
    if (start === Infinity) return;
    endPre = Math.max(endPre, endPost - delta);
    const first = this.shape.childAtElement(doc, start), last = this.shape.childAtElement(doc, Math.max(start, endPre));
    const from = Math.max(0, first - 1), to = Math.min(doc.childCount, last + 2);
    const offset = this.windowStart(doc, from, to);
    const before = this.windowLines(doc, from, to);
    if (offset === undefined || before.length === 0) { this.show(view, this.shape.doc(textLines(this.text))); return; }
    const lines = textLines(this.text, offset, textLength(before) + delta);
    const layout = this.shape.layout(doc);
    const fromPos = layout.positions[from]!, toPos = to < doc.childCount ? layout.positions[to]! : doc.content.size;
    const tr = view.state.tr.replaceWith(fromPos, toPos, Fragment.from(this.shape.nodes(lines.length === 0 ? [{ runs: [], attributes: {} }] : lines)));
    this.restoreSelection(tr);
    view.dispatch(tr.setMeta(syncKey, "text").setMeta("addToHistory", false));
  }

  // Input method compositions.

  /** Starts keeping edits in the editor: candidates are not written until the composition ends. */
  startComposition(state: EditorState): void {
    if (this.composition !== undefined || this.failed) return;
    const doc = state.doc;
    const layout = this.shape.layout(doc);
    const head = this.shape.elementAt(doc, state.selection.from), tail = this.shape.elementAt(doc, state.selection.to);
    // The composition's paragraphs: from the start of the selection's first line to the end of its last.
    const lineBounds = (element: number): [number, number] => {
      const child = this.shape.childAtElement(doc, element);
      const info = this.shape.nodeInfo(doc.child(child));
      let start = layout.elements[child]!;
      for (const length of info.lengths) {
        if (element <= start + length) return [start, start + length];
        start += length + 1;
      }
      return [start, start];
    };
    const from = lineBounds(head)[0], to = lineBounds(tail)[1];
    const gaps: { left: Cursor; right: Cursor }[] = [];
    for (let element = from; element <= to; element++) gaps.push({ left: this.text.cursorAt(element), right: this.text.cursorAt(element, "right") });
    this.composition = { base: doc, from, gaps, selection: this.selection, incoming: false, cancelled: false };
  }

  /** Marks the composition cancelled, as an Escape that ends it does. */
  cancelComposition(): void { if (this.composition !== undefined) this.composition.cancelled = true; }
  /** Undoes a cancellation, as a key that keeps composing does. */
  resumeComposition(): void { if (this.composition !== undefined) this.composition.cancelled = false; }

  /** Ends the composition once ProseMirror has read its final text. */
  scheduleFinish(view: EditorView): void {
    this.ending ??= setTimeout(() => { this.ending = undefined; if (!view.composing) this.finishComposition(view); }, 0);
  }

  /**
   * Writes the composition's text as one batch, unless it was cancelled, and shows the changes from
   * elsewhere that waited. A composition that cannot be written goes to `onUnsentComposition`.
   */
  finishComposition(view: EditorView): void {
    clearTimeout(this.ending);
    this.ending = undefined;
    const started = this.composition;
    if (started === undefined || this.failed) return;
    this.composition = undefined;
    try {
      const draft = view.state.doc;
      const window = changedWindow(started.base, draft);
      const before = window === undefined ? [] : this.windowLines(started.base, window.from, window.toA);
      const after = window === undefined ? [] : this.windowLines(draft, window.from, window.toB);
      const offset = window === undefined ? 0 : this.windowStart(started.base, window.from, window.toA) ?? 0;
      let unsent = window !== undefined && !started.cancelled;
      let rebased: number | undefined;
      const change = splice(codePoints(before), codePoints(after));
      if (unsent && this.canWrite()) {
        this.options.history?.stopCapturing();
        this.writing = true;
        try {
          if (!started.incoming) {
            // Nothing changed elsewhere: the usual comparison is exact.
            this.write(started.base, draft);
            unsent = false;
          } else {
            this.doc.transact(() => { rebased = this.rebase(started, offset, before, after, change); });
            unsent = rebased === undefined;
          }
        } finally { this.writing = false; }
        this.options.history?.stopCapturing();
      }
      if (started.cancelled || unsent) this.selection = started.selection;
      else if (!started.incoming) this.selection = this.cursorsOf(view.state);
      else {
        // The caret in the draft: in the inserted text, or in the base lines around it.
        const head = this.shape.elementAt(draft, view.state.selection.head), index = offset + change.index;
        const shift = change.insert.length - change.count;
        if (rebased !== undefined && head >= index && head <= index + change.insert.length) {
          const caret = this.text.cursorAt(rebased + head - index);
          this.selection = { from: caret, to: caret };
        } else {
          const gap = started.gaps[(head < index ? head : head - shift) - started.from];
          this.selection = gap === undefined ? started.selection : { from: gap.left, to: gap.left };
        }
      }
      // Shown even when unchanged, so the selection and other writers' carets are placed again.
      this.show(view, this.shape.doc(textLines(this.text)));
      if (unsent) this.options.onUnsentComposition?.(change.insert.join("") || "(a deletion)");
    } catch (error) { this.fail(error); }
  }

  /**
   * Writes a composition's replacement into a Text that changed since it started: elements deleted
   * elsewhere stay deleted, and text inserted elsewhere stays. Returns where the inserted text
   * starts, or undefined when the change is not inside the composition's paragraphs.
   */
  private rebase(
    started: NonNullable<TextBinding["composition"]>, offset: number, before: readonly Line[], after: readonly Line[],
    change: ReturnType<typeof splice>,
  ): number | undefined {
    const index = offset + change.index, { count, insert } = change, { from, gaps } = started;
    if (index < from || index + count > from + gaps.length - 1 || insert.includes("\n")) return undefined;
    // Formatting outside the replacement is not a composition's: leave such a change unsent.
    const marksBefore = pointMarks(before), marksAfter = pointMarks(after), shift = insert.length - count;
    for (const [at, marks] of marksAfter.entries()) {
      if (at >= change.index && at < change.index + insert.length) continue;
      if (!sameJson(marks ?? null, marksBefore[at < change.index ? at : at - shift] ?? null)) return undefined;
    }
    if (!sameJson(after.map((line) => line.attributes), before.map((line) => line.attributes))) return undefined;
    const gap = (element: number) => {
      const found = gaps[element - from];
      if (found === undefined) throw new Error("Composition gap out of range");
      return found;
    };
    const removed: number[] = [];
    for (let element = index; element < index + count; element++) {
      // Both cursors bind to the element: the gaps before and after it are one apart while it exists.
      const start = this.text.cursorIndex(gap(element).right), end = this.text.cursorIndex(gap(element + 1).left);
      if (start !== undefined && end === start + 1) removed.push(start);
    }
    for (const element of removed.toSorted((a, b) => b - a)) this.text.delete(element, 1);
    const at = this.text.cursorIndex(gap(index).left);
    if (at === undefined) throw new Error("Composition position is not known");
    if (insert.length === 0) return at;
    this.text.insert(at, insert.join(""));
    const wanted = marksAfter.slice(change.index, change.index + insert.length);
    const have = pointMarks(textLines(this.text, at, insert.length));
    this.formatRuns(wanted, have, at);
    return at;
  }
}

/**
 * A ProseMirror plugin that keeps the editor and the Text at `path` in step. Local transactions are
 * compared with the Text only where they changed the document, and written as one batch; changes
 * from elsewhere rebuild only the top-level nodes they touched. The editor always shows the Text's
 * standard shape. An input method composition is written once confirmed, and not at all when
 * Escape cancels it.
 */
export function textSync<S extends SchemaShape>(
  doc: ClientDocument<S>, path: TextPath<S>, options: TextSyncOptions = {},
): Plugin<SyncState> {
  const synced: SyncedDocument = doc;
  if (!Object.hasOwn(synced.state, path)) throw new TypeError(`Unknown collection path: ${path}`);
  const collection = synced.state[path];
  if (typeof collection !== "object" || collection === null || !("toDelta" in collection)) throw new TypeError(`Not a Text collection: ${path}`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A Text, checked above; its mark and block keys come from the mapping.
  const text = collection as unknown as SyncedText;
  let binding: TextBinding | undefined;
  const bindingFor = (schema: Schema) => (binding ??= new TextBinding(synced, text, schema, options));
  return new Plugin<SyncState>({
    key: syncKey,
    state: {
      init: (_config, state) => ({ binding: bindingFor(state.schema), fromText: false }),
      apply: (tr, value) => {
        const fromText = tr.getMeta(syncKey) === "text";
        return value.fromText === fromText ? value : { binding: value.binding, fromText };
      },
    },
    filterTransaction(tr, state) {
      const own = bindingFor(state.schema);
      // A composition that started before its compositionstart event reached this editor.
      if (!own.composing && tr.getMeta("composition") !== undefined) own.startComposition(state);
      if (!tr.docChanged || tr.getMeta(syncKey) !== undefined || own.composing) return true;
      // Refused edits leave the editor as it was.
      return own.canWrite();
    },
    appendTransaction(transactions, oldState, newState) {
      const own = bindingFor(newState.schema);
      if (own.composing || own.failed || oldState.doc === newState.doc) return null;
      if (transactions.some((tr) => tr.getMeta(syncKey) === "text")) return null;
      return own.standardize(oldState.doc, newState.doc, newState.tr) ?? null;
    },
    view(view) {
      const own = bindingFor(view.state.schema);
      own.attach(view);
      return {
        update(updated, previous) {
          if (own.composing && !updated.composing) own.scheduleFinish(updated);
          own.updated(updated, previous);
        },
        destroy() { own.detach(); },
      };
    },
    props: {
      handleDOMEvents: {
        compositionstart(view) {
          const own = bindingFor(view.state.schema);
          // The last composition is still waiting to be written: write it first.
          if (own.finishing) own.finishComposition(view);
          own.startComposition(view.state);
          return false;
        },
        compositionend(view) { bindingFor(view.state.schema).scheduleFinish(view); return false; },
        keydown(view, event) {
          const own = bindingFor(view.state.schema);
          if (!own.composing) return false;
          // A key after the composition, which ProseMirror may end without compositionend: write it first.
          if (!view.composing) own.finishComposition(view);
          // macOS Zhuyin can end an Escape cancellation with the phonetic text still in the editor.
          else if (event.key === "Escape") own.cancelComposition();
          else if (event.isComposing) own.resumeComposition();
          return false;
        },
      },
    },
  });
}

/** The ProseMirror document showing a Text, in the mapping's standard shape. */
export function textToDoc(
  text: { toDelta(): readonly { readonly insert: string; readonly attributes?: Attributes }[]; blocks(): readonly { readonly attributes: Attributes }[] },
  schema: Schema, mapping: TextMapping = basicMapping,
): Node {
  return new TextShape(schema, mapping).doc(textLines(text));
}

/** The editor's selection as cursors, for sharing as presence; undefined without the `textSync` plugin. */
export function selectionCursors(state: EditorState): CursorSelection | undefined {
  const sync = syncKey.getState(state);
  if (sync === undefined || sync.binding.composing) return undefined;
  return sync.binding.selection ?? sync.binding.cursorsOf(state);
}

/** Another writer's selection in this editor's positions, or undefined while its text is unknown here. */
export function resolveSelection(state: EditorState, cursors: CursorSelection): { from: number; to: number } | undefined {
  const sync = syncKey.getState(state);
  if (sync === undefined || sync.binding.composing) return undefined;
  return sync.binding.resolve(cursors, state.doc);
}

/** The binding of an editor with the `textSync` plugin. Internal, for the remote selections plugin. */
export function bindingOf(state: EditorState): TextBinding | undefined {
  return syncKey.getState(state)?.binding;
}

/** Whether an input method composition is open in the editor; commands and keys should wait for it. */
export function isComposing(view: EditorView): boolean {
  return view.composing || bindingOf(view.state)?.composing === true;
}

/** Whether `tr` shows a change from the Text, which positions from cursors already match. */
export function isFromText(tr: Transaction): boolean {
  return tr.getMeta(syncKey) === "text";
}

/** A command that undoes this writer's latest change; false when there is nothing to undo or undo is not possible now. */
export function undo(history: UndoManager): Command {
  return (state, dispatch, view) => {
    if (!history.canUndo || bindingOf(state)?.composing === true || view?.composing === true) return false;
    if (dispatch === undefined) return true;
    try { return history.undo(); } catch { return false; }
  };
}

/** A command that redoes the latest undone change. */
export function redo(history: UndoManager): Command {
  return (state, dispatch, view) => {
    if (!history.canRedo || bindingOf(state)?.composing === true || view?.composing === true) return false;
    if (dispatch === undefined) return true;
    try { return history.redo(); } catch { return false; }
  };
}
