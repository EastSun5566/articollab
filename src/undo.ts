import { equalsId, type ElementId } from "articulated";
import { historyWriter } from "./history-access.ts";
import { jsonEquals } from "./json.ts";
import { RuntimeList, type ListState } from "./list.ts";
import { RuntimeMap, type MapState } from "./map.ts";
import { RuntimeCounter, RuntimeCounterMap, type CounterMapState } from "./counter.ts";
import { attachHistory, isTransacting, type ClientDocument, type LocalStep, type Value } from "./runtime.ts";
import type { JsonValue, SchemaShape } from "./schema.ts";
import type { CollectionState } from "./state.ts";
import { RuntimeText, type TextIdRange, type TextState } from "./text.ts";

export interface UndoManagerOptions {
  /** Local batches less than this many milliseconds apart form one step. Default 500; 0 never merges. */
  readonly captureTimeout?: number;
  /** The collections whose changes are recorded. Default: all. */
  readonly paths?: readonly string[];
  /** The most undo steps kept, and the most redo steps; the oldest is dropped beyond it. Default 1000. */
  readonly maxSteps?: number;
}

/** Undo and redo for one writer's own changes. Create it with `createUndoManager`. */
export interface UndoManager {
  /** Reverts the latest step that still has an effect; returns whether anything changed. */
  undo(): boolean;
  /** Reapplies the latest undone step that still has an effect; returns whether anything changed. */
  redo(): boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Makes the next local change start a new step, even within `captureTimeout`, and ends open groups. */
  stopCapturing(): void;
  /**
   * Starts one step that takes every local change until the returned function is called, however far
   * apart. Groups nest; undo, redo, stopCapturing, clear and destroy end them all.
   */
  startGroup(): () => void;
  /** Runs `callback` without recording the local changes it makes, and returns its result. */
  ignore<T>(
    callback: () => T,
    ...mustBeSynchronous: [T] extends [never]
      ? []
      : T extends PromiseLike<unknown>
        ? [never]
        : []
  ): T;
  /** Forgets every step. */
  clear(): void;
  /** Called whenever the undo or redo stack changes. Returns an unsubscribe function. */
  on(event: "change", listener: () => void): () => void;
  /** Stops recording and forgets every step; the document can then get a new manager. */
  destroy(): void;
}

/** What one step changed in one collection: the states around it and the targets it touched. */
interface PathStep {
  readonly before: CollectionState;
  after: CollectionState;
  /** Map keys, List element IDs or Text ID ranges, as the operations named them. */
  readonly keys: Set<string>;
  readonly ids: Readonly<ElementId>[];
  readonly ranges: TextIdRange[];
  /** Counter paths: the net amount each key changed, summed over the step's batches ("" for a Counter). */
  readonly deltas: Map<string, number>;
}

interface Step {
  readonly paths: Map<string, PathStep>;
}

type Collection =
  | RuntimeList<JsonValue> | RuntimeText | RuntimeMap<JsonValue> | RuntimeCounter | RuntimeCounterMap | Value<JsonValue>;

function idKey(id: Readonly<ElementId>): string {
  return JSON.stringify([id.bunchId, id.counter]);
}

function* idsIn(ranges: readonly TextIdRange[]): IterableIterator<Readonly<ElementId>> {
  for (const range of ranges) {
    for (let offset = 0; offset < range.count; offset++) {
      yield { bunchId: range.start.bunchId, counter: range.start.counter + offset };
    }
  }
}

/** Absent and present-but-equal compare as JSON; `undefined` stands for an absent Map key. */
function sameEntry(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return left === undefined || right === undefined ? left === right : jsonEquals(left, right);
}

/** Whether two adjacent Text elements would merge into one code point if inserted together. */
function joinsSurrogates(left: string, right: string): boolean {
  const high = left.charCodeAt(left.length - 1), low = right.charCodeAt(0);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * Records this writer's local batches as undoable steps. Undo and redo write ordinary local batches
 * that revert only what nobody has changed since; see the reference for the exact rules.
 */
export function createUndoManager<S extends SchemaShape>(
  doc: ClientDocument<S>, options: UndoManagerOptions = {}
): UndoManager {
  // Mid-transaction, earlier edits of the open batch already happened and would be recorded wrongly.
  if (isTransacting(doc)) throw new Error("Cannot create an undo manager inside a transaction");
  const captureTimeout = options.captureTimeout ?? 500;
  if (typeof captureTimeout !== "number" || !(captureTimeout >= 0)) {
    throw new RangeError("captureTimeout must be a non-negative number");
  }
  const maxSteps = options.maxSteps ?? 1000;
  if (maxSteps !== Infinity && !(Number.isSafeInteger(maxSteps) && maxSteps > 0)) {
    throw new RangeError("maxSteps must be a positive integer or Infinity");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Every document path holds one runtime collection.
  const collections = doc.state as unknown as Readonly<Record<string, Collection>>;
  const paths = new Set(options.paths ?? Object.keys(collections));
  for (const path of paths) {
    if (!Object.hasOwn(collections, path)) throw new Error(`Unknown document path: ${path}`);
  }

  const undoStack: Step[] = [], redoStack: Step[] = [];
  /**
   * Per path, IDs that undo or redo replaced. `elements`: a reinserted element's old ID to its new
   * one. `positions`: an old List position to the one that now stands in its place, after a
   * reinsertion or a move back, so earlier steps' move checks still recognize it.
   */
  const elements = new Map<string, Map<string, Readonly<ElementId>>>();
  const positions = new Map<string, Map<string, Readonly<ElementId>>>();
  const listeners = new Set<() => void>();
  let recording: "edit" | "undo" | "redo" = "edit";
  let lastEdit = -Infinity, separate = true, destroyed = false;
  /** Open groups, and a token that ends their stale end functions once groups are forced closed. */
  let groupDepth = 0, groupToken = {};
  let ignoring = 0;
  const push = (stack: Step[], step: Step) => {
    stack.push(step);
    if (stack.length > maxSteps) stack.shift();
  };
  /** The next local change starts a new step; open groups end and their end functions do nothing. */
  const endGroups = () => {
    groupDepth = 0;
    groupToken = {};
    separate = true;
  };

  const emit = () => { for (const listener of [...listeners]) listener(); };
  const resolve = (table: typeof elements, path: string, id: Readonly<ElementId>): Readonly<ElementId> => {
    const map = table.get(path);
    let resolved = id;
    for (let next = map?.get(idKey(resolved)); next !== undefined; next = map!.get(idKey(resolved))) resolved = next;
    return resolved;
  };
  const replace = (table: typeof elements, path: string, from: Readonly<ElementId>, to: Readonly<ElementId>) => {
    let map = table.get(path);
    if (map === undefined) table.set(path, map = new Map<string, Readonly<ElementId>>());
    map.set(idKey(from), to);
  };
  const current = (path: string, id: Readonly<ElementId>) => resolve(elements, path, id);

  function capture(step: LocalStep<S>): Step | undefined {
    const entries = new Map<string, PathStep>();
    for (const operation of step.batch.operations) {
      if (!paths.has(operation.path)) continue;
      let entry = entries.get(operation.path);
      if (entry === undefined) {
        entry = { before: step.before.get(operation.path)!, after: step.after.get(operation.path)!,
          keys: new Set(), ids: [], ranges: [], deltas: new Map() };
        entries.set(operation.path, entry);
      }
      switch (operation.type) {
        case "map/set": case "map/delete": entry.keys.add(operation.key); break;
        case "list/insert": case "list/delete": case "list/set": case "list/move": entry.ids.push(operation.id); break;
        // oxlint-disable-next-line typescript/no-misused-spread -- Text elements are Unicode code points.
        case "text/insert": entry.ranges.push({ start: operation.id, count: [...operation.value].length }); break;
        case "text/delete": entry.ranges.push(...operation.ranges); break;
        case "counter/add": entry.keys.add(""); break;
        case "counters/add": case "counters/delete": entry.keys.add(operation.key); break;
        case "value/set": break;
      }
    }
    // A batch's net effect on a counter is its after state less its before state: additions commute.
    for (const [path, entry] of entries) {
      const collection = collections[path];
      if (collection instanceof RuntimeCounter) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Counter paths keep their total as state.
        entry.deltas.set("", (entry.after as number) - (entry.before as number));
      } else if (collection instanceof RuntimeCounterMap) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- CounterMap paths keep CounterMapState snapshots.
        const before = entry.before as CounterMapState, after = entry.after as CounterMapState;
        for (const key of entry.keys) entry.deltas.set(key, after.get(key) - before.get(key));
      }
    }
    return entries.size === 0 ? undefined : { paths: entries };
  }

  function merge(into: Step, step: Step): void {
    for (const [path, entry] of step.paths) {
      const existing = into.paths.get(path);
      if (existing === undefined) { into.paths.set(path, entry); continue; }
      existing.after = entry.after;
      for (const key of entry.keys) existing.keys.add(key);
      existing.ids.push(...entry.ids);
      existing.ranges.push(...entry.ranges);
      for (const [key, delta] of entry.deltas) existing.deltas.set(key, (existing.deltas.get(key) ?? 0) + delta);
    }
  }

  attachHistory(doc, (local) => {
    if (ignoring > 0) return;
    const step = capture(local);
    // A batch whose effects cancel out, such as inserting and deleting one element, is no step.
    if (step === undefined || reverts(step).length === 0) return;
    if (recording === "undo") push(redoStack, step);
    else if (recording === "redo") push(undoStack, step);
    else {
      redoStack.length = 0;
      const now = Date.now();
      const top = undoStack.at(-1);
      // Within a group every change joins its step; otherwise only changes within captureTimeout do.
      if (top !== undefined && !separate && (groupDepth > 0 || now - lastEdit < captureTimeout)) merge(top, step);
      else push(undoStack, step);
      lastEdit = now;
      separate = false;
    }
    emit();
  });

  /** The writes that revert `step` where nothing has changed it since, against current state. */
  function reverts(step: Step): (() => void)[] {
    const writes: (() => void)[] = [];
    for (const [path, entry] of step.paths) {
      const collection = collections[path]!;
      if (collection instanceof RuntimeList) {
        writes.push(...listReverts(path, collection, entry));
      } else if (collection instanceof RuntimeText) {
        writes.push(...textReverts(path, collection, entry));
      } else if (collection instanceof RuntimeCounter) {
        // Additions commute, so the inverse applies whatever other writers added since.
        const delta = entry.deltas.get("") ?? 0;
        if (delta !== 0) writes.push(() => { collection.add(-delta); });
      } else if (collection instanceof RuntimeCounterMap) {
        for (const [key, delta] of entry.deltas) {
          if (delta !== 0) writes.push(() => { collection.add(key, -delta); });
        }
      } else if (collection instanceof RuntimeMap) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Map paths keep MapState snapshots.
        const before = entry.before as MapState<JsonValue>, after = entry.after as MapState<JsonValue>;
        for (const key of entry.keys) {
          const was = before.get(key), is = after.get(key);
          if (sameEntry(was, is) || !sameEntry(collection.get(key), is)) continue;
          writes.push(was === undefined ? () => { collection.delete(key); } : () => { collection.set(key, was); });
        }
      } else {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Value paths keep their JSON value as state.
        const was = entry.before as JsonValue, is = entry.after as JsonValue;
        if (!jsonEquals(was, is) && jsonEquals(collection.value, is)) writes.push(() => { collection.set(was); });
      }
    }
    return writes;
  }

  function listReverts(path: string, list: RuntimeList<JsonValue>, entry: PathStep): (() => void)[] {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- List paths keep ListState snapshots.
    const before = entry.before as ListState<JsonValue>, after = entry.after as ListState<JsonValue>;
    const now = list.state, writer = list[historyWriter]();
    const writes: (() => void)[] = [], seen = new Set<string>();
    for (const id of entry.ids) {
      if (seen.has(idKey(id))) continue;
      seen.add(idKey(id));
      const target = current(path, id), was = before.has(id), is = after.has(id);
      if (!was && is) {
        if (now.has(target)) writes.push(() => { writer.delete(target); });
      } else if (was && !is) {
        // Reinsert at its old place: right after its last position, which is a known tombstone.
        const anchor = before.positionFor(id), value = before.valueFor(id);
        if (!now.has(target) && now.knows(anchor)) {
          writes.push(() => {
            const inserted = writer.insertAfter(anchor, value);
            // The new element stands for the old one and, for move checks, for its old position.
            replace(elements, path, target, inserted);
            replace(positions, path, anchor, inserted);
          });
        }
      } else if (was && is && now.has(target)) {
        const value = before.valueFor(id), changed = after.valueFor(id);
        if (!jsonEquals(value, changed) && jsonEquals(now.valueFor(target), changed)) {
          writes.push(() => { writer.set(target, value); });
        }
        const from = before.positionFor(id), to = after.positionFor(id);
        if (!equalsId(from, to) && equalsId(now.positionFor(target), resolve(positions, path, to)) && now.knows(from)) {
          // The new position, right after `from`, stands for it in earlier steps' move checks.
          writes.push(() => { replace(positions, path, from, writer.moveAfter(target, from)); });
        }
      }
    }
    return writes;
  }

  function textReverts(path: string, text: RuntimeText, entry: PathStep): (() => void)[] {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Text paths keep TextState snapshots.
    const before = entry.before as TextState, after = entry.after as TextState;
    const now = text.state, writer = text[historyWriter]();
    const inserted: Readonly<ElementId>[] = [];
    const deleted: { index: number; target: Readonly<ElementId>; value: string }[] = [];
    const seen = new Set<string>();
    for (const id of idsIn(entry.ranges)) {
      if (seen.has(idKey(id))) continue;
      seen.add(idKey(id));
      const target = current(path, id), was = before.has(id), is = after.has(id);
      if (!was && is && now.has(target)) inserted.push(target);
      else if (was && !is && !now.has(target) && now.knows(target)) {
        deleted.push({ index: now.knownIndexOf(target), target, value: before.valueFor(id) });
      }
    }
    const writes: (() => void)[] = [];
    if (inserted.length > 0) writes.push(() => { writer.delete(inserted); });
    // Each run of deleted elements with no other known element between them, tombstones included,
    // goes back right after the tombstone of its last element, so it keeps its place and order.
    deleted.sort((left, right) => left.index - right.index);
    for (let start = 0; start < deleted.length;) {
      let end = start + 1;
      while (end < deleted.length && deleted[end]!.index === deleted[end - 1]!.index + 1) end++;
      const run = deleted.slice(start, end);
      writes.push(() => {
        let anchor = run.at(-1)!.target;
        // Insert piecewise where joining would merge separate surrogate halves into one code point.
        for (let piece = 0; piece < run.length;) {
          let stop = piece + 1;
          while (stop < run.length && !joinsSurrogates(run[stop - 1]!.value, run[stop]!.value)) stop++;
          const chunk = run.slice(piece, stop);
          const first = writer.insertAfter(anchor, chunk.map(({ value }) => value).join(""));
          chunk.forEach(({ target }, offset) =>
            replace(elements, path, target, { bunchId: first.bunchId, counter: first.counter + offset }));
          anchor = { bunchId: first.bunchId, counter: first.counter + chunk.length - 1 };
          piece = stop;
        }
      });
      start = end;
    }
    return writes;
  }

  function travel(direction: "undo" | "redo"): boolean {
    if (destroyed) throw new Error("This undo manager was destroyed");
    if (isTransacting(doc)) throw new Error(`Cannot ${direction} inside a transaction`);
    if (doc.replayConflict !== null) throw new Error("Cannot mutate while pending replay is blocked");
    const stack = direction === "undo" ? undoStack : redoStack;
    let changed = false;
    try {
      while (stack.length > 0) {
        const writes = reverts(stack.at(-1)!);
        if (writes.length === 0) {
          // Everything this step did was changed since by someone else, or never took effect.
          stack.pop();
          changed = true;
          continue;
        }
        recording = direction;
        try {
          doc.transact(() => { for (const write of writes) write(); });
        } finally {
          recording = "edit";
        }
        stack.pop();
        endGroups();
        changed = true;
        return true;
      }
      return false;
    } finally {
      if (changed) emit();
    }
  }

  function ignore<T>(
    callback: () => T,
    ...mustBeSynchronous: [T] extends [never]
      ? []
      : T extends PromiseLike<unknown>
        ? [never]
        : []
  ): T;
  function ignore<T>(callback: () => T, ..._synchronous: readonly unknown[]): T {
    // Inside a transaction the batch commits after the callback, outside its reach.
    if (isTransacting(doc)) throw new Error("Cannot ignore changes inside a transaction");
    ignoring++;
    try {
      return callback();
    } finally {
      ignoring--;
    }
  }

  return Object.freeze({
    undo: () => travel("undo"),
    redo: () => travel("redo"),
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    stopCapturing() { endGroups(); },
    startGroup() {
      // The group's first change starts its own step.
      if (groupDepth === 0) separate = true;
      groupDepth++;
      const token = groupToken;
      let ended = false;
      return () => {
        if (ended || token !== groupToken) return;
        ended = true;
        groupDepth--;
        // The change after a group starts a new step.
        if (groupDepth === 0) separate = true;
      };
    },
    ignore,
    clear() {
      const had = undoStack.length > 0 || redoStack.length > 0;
      undoStack.length = 0; redoStack.length = 0; elements.clear(); positions.clear(); endGroups();
      if (had) emit();
    },
    on(event: "change", listener: () => void) {
      if (event !== "change") throw new Error(`Unknown event: ${String(event)}`);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      endGroups();
      attachHistory(doc, undefined);
      undoStack.length = 0; redoStack.length = 0; elements.clear(); positions.clear(); listeners.clear();
    },
  });
}
