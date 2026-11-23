import {
  ElementIdGenerator,
  equalsId,
  IdList,
  type ElementId,
  type SavedIdList,
} from "articulated";

import type { JsonValue } from "./schema.ts";
import { CollectionConflictError } from "./conflict.ts";
import { HamtMap } from "./vendor/hamt.ts";
import { validateJsonValue } from "./json.ts";
import { CollectionObservers, elementTargets } from "./observe.ts";
import { cursorAt, cursorIndex, type Cursor } from "./cursor.ts";
import { historyWriter } from "./history-access.ts";
import { checkPayload, type PayloadSchema } from "./payload.ts";
import { requireNumber } from "./options.ts";

export interface SavedIdRange {
  readonly bunchId: string;
  readonly startCounter: number;
  readonly count: number;
  readonly isDeleted: boolean;
}

/** A moved element: its permanent ID and the position ID it occupies now. */
export interface ListMoveEntry {
  readonly id: Readonly<ElementId>;
  readonly position: Readonly<ElementId>;
}

export interface ListSnapshotData<T extends JsonValue = JsonValue> {
  readonly idList: readonly SavedIdRange[];
  readonly values: readonly T[];
  /** Visible elements that were moved; omitted when there are none. */
  readonly moves?: readonly ListMoveEntry[];
}

export interface ListInsertOperation<
  Path extends string = string,
  T extends JsonValue = JsonValue,
> {
  readonly type: "list/insert";
  readonly path: Path;
  readonly before: Readonly<ElementId> | null;
  readonly id: Readonly<ElementId>;
  readonly value: T;
}

export interface ListDeleteOperation<Path extends string = string> {
  readonly type: "list/delete";
  readonly path: Path;
  readonly id: Readonly<ElementId>;
}

export interface ListSetOperation<
  Path extends string = string,
  T extends JsonValue = JsonValue,
> {
  readonly type: "list/set";
  readonly path: Path;
  readonly id: Readonly<ElementId>;
  readonly value: T;
}

/**
 * Moves element `id` to a new position after `before`. `position` is a new ID from the mover's
 * namespace; `id` keeps identifying the element for later sets, deletes and moves.
 */
export interface ListMoveOperation<Path extends string = string> {
  readonly type: "list/move";
  readonly path: Path;
  readonly id: Readonly<ElementId>;
  readonly before: Readonly<ElementId> | null;
  readonly position: Readonly<ElementId>;
}

export type ListOperation<
  Path extends string = string,
  T extends JsonValue = JsonValue,
> = ListInsertOperation<Path, T> | ListDeleteOperation<Path> | ListSetOperation<Path, T> | ListMoveOperation<Path>;

/**
 * A visible List edit. Apply an event's changes in order; each index refers to the view after the
 * changes before it. A move removes the element at `from` and reinserts it so it ends at `to`.
 */
export type ListChange<T extends JsonValue = JsonValue> =
  | {
    readonly type: "splice";
    readonly index: number;
    readonly deleteCount: number;
    readonly insert: readonly T[];
  }
  | { readonly type: "set"; readonly index: number; readonly value: T }
  | { readonly type: "move"; readonly from: number; readonly to: number; readonly value: T };

type IndexedChange<T extends JsonValue> = Exclude<ListChange<T>, { readonly type: "move" }>;

export interface ListChangeEvent<T extends JsonValue = JsonValue> {
  readonly beforeLength: number;
  readonly afterLength: number;
  readonly changes: readonly ListChange<T>[];
}

/** An optimistic collaborative list of immutable values. */
export interface List<T extends JsonValue> extends Iterable<T> {
  readonly length: number;
  get(index: number): T;
  set(index: number, value: T): void;
  insert(index: number, value: T): void;
  push(value: T): void;
  delete(index: number): void;
  /** Moves the element at `from` so that it ends at index `to`, keeping its identity. */
  move(from: number, to: number): void;
  values(): IterableIterator<T>;
  toArray(): T[];
  /** Subscribes from the current view; apply each event's changes in order. */
  observe(listener: (event: ListChangeEvent<T>) => void): () => void;
  /** A stable position for the gap before `index`; "left" binds to the element before it. */
  cursorAt(index: number, bind?: "left" | "right"): Cursor;
  /** The cursor's current index, or undefined while its anchor element is not known here. */
  cursorIndex(cursor: Cursor): number | undefined;
}

/**
 * Moves first, in order; then descending indices, where at one index a set applies before a splice
 * that may insert there. Applying the changes in order therefore always keeps indices valid.
 */
function listChangeEvent<T extends JsonValue>(
  beforeLength: number, afterLength: number, changes: IndexedChange<T>[], moves: ListChange<T>[] = []
): ListChangeEvent<T> {
  changes.sort((left, right) => right.index - left.index ||
    (left.type === right.type ? 0 : left.type === "set" ? -1 : 1));
  return Object.freeze({ beforeLength, afterLength, changes: Object.freeze([...moves, ...changes]) });
}

function moveChange<T extends JsonValue>(from: number, to: number, value: T): ListChange<T> {
  return Object.freeze({ type: "move", from, to, value });
}

function spliceChange<T extends JsonValue>(index: number, deleteCount: number, insert: T[]): IndexedChange<T> {
  return Object.freeze({ type: "splice", index, deleteCount, insert: Object.freeze(insert) });
}

function setChange<T extends JsonValue>(index: number, value: T): IndexedChange<T> {
  return Object.freeze({ type: "set", index, value });
}

function idKey(id: Readonly<ElementId>): string {
  return JSON.stringify([id.bunchId, id.counter]);
}

function ownId(id: Readonly<ElementId>): Readonly<ElementId> {
  return Object.freeze({ bunchId: id.bunchId, counter: id.counter });
}

function requireElementId(value: unknown, name: string): ElementId {
  const record = requireObject(value, name) as { readonly bunchId?: unknown; readonly counter?: unknown };
  if (typeof record.bunchId !== "string" || record.bunchId.length === 0 ||
    typeof record.counter !== "number" || !Number.isSafeInteger(record.counter) || record.counter < 0) {
    throw new Error(`${name} must be an element ID`);
  }
  return { bunchId: record.bunchId, counter: record.counter };
}

function requireObject(value: unknown, name: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

export function loadIdList(
  ranges: readonly SavedIdRange[],
  name: string
): IdList {
  const intervalsByBunch = new Map<
    string,
    Array<{ readonly start: number; readonly end: number }>
  >();
  const saved = ranges.map((range, index) => {
    requireObject(range, `${name} entry ${index}`);
    const object = range;
    if (typeof object.bunchId !== "string" || object.bunchId.length === 0) {
      throw new Error(`${name} entry ${index} bunchId must not be empty`);
    }
    if (
      !Number.isSafeInteger(object.startCounter) ||
      object.startCounter < 0 ||
      !Number.isSafeInteger(object.count) ||
      object.count < 1 ||
      object.startCounter > Number.MAX_SAFE_INTEGER - object.count + 1
    ) {
      throw new Error(`${name} entry ${index} has an invalid range`);
    }
    if (typeof object.isDeleted !== "boolean") {
      throw new Error(`${name} entry ${index} isDeleted must be a boolean`);
    }

    const intervals = intervalsByBunch.get(object.bunchId) ?? [];
    intervals.push({
      start: object.startCounter,
      end: object.startCounter + object.count - 1,
    });
    intervalsByBunch.set(object.bunchId, intervals);
    return { ...object };
  }) as SavedIdList;

  for (const intervals of intervalsByBunch.values()) {
    intervals.sort((left, right) => left.start - right.start);
    for (let index = 1; index < intervals.length; index++) {
      if (intervals[index]!.start <= intervals[index - 1]!.end) {
        throw new Error(`${name} ranges must not overlap`);
      }
    }
  }

  return IdList.load(saved);
}

/**
 * Internal persistent state for one List collection.
 *
 * An element's ID is permanent: sets, deletes and moves name it. Its position ID is where it sits
 * in the IdList now. They are equal until the element moves; `positionOf`/`logicalOf` hold the
 * pairs for visible moved elements only, so a deleted element falls back to its original,
 * tombstoned position and reads as known but absent.
 */
export class ListState<T extends JsonValue> {
  private readonly idList: IdList;
  private readonly valuesById: HamtMap<T>;
  private readonly positionOf: HamtMap<Readonly<ElementId>>;
  private readonly logicalOf: HamtMap<Readonly<ElementId>>;

  private constructor(
    idList: IdList,
    valuesById: HamtMap<T>,
    positionOf: HamtMap<Readonly<ElementId>> = HamtMap.empty(),
    logicalOf: HamtMap<Readonly<ElementId>> = HamtMap.empty()
  ) {
    this.idList = idList;
    this.valuesById = valuesById;
    this.positionOf = positionOf;
    this.logicalOf = logicalOf;
  }

  static empty<T extends JsonValue>(): ListState<T> {
    return new ListState<T>(IdList.new(), HamtMap.empty<T>());
  }

  static load<T extends JsonValue>(snapshot: ListSnapshotData<T>): ListState<T> {
    const data = requireObject(snapshot, "List snapshot") as Partial<
      ListSnapshotData<T>
    >;
    if (!Array.isArray(data.idList)) {
      throw new Error("List snapshot idList must be an array");
    }
    if (!Array.isArray(data.values)) {
      throw new Error("List snapshot values must be an array");
    }

    const idList = loadIdList(data.idList, "List snapshot idList");
    if (idList.length !== data.values.length) {
      throw new Error(
        `List snapshot has ${idList.length} present ids but ${data.values.length} values`
      );
    }

    let positionOf = HamtMap.empty<Readonly<ElementId>>();
    let logicalOf = HamtMap.empty<Readonly<ElementId>>();
    if (data.moves !== undefined) {
      if (!Array.isArray(data.moves)) throw new Error("List snapshot moves must be an array");
      const entries: readonly unknown[] = data.moves;
      const moves = entries.map((entry, index) => {
        const record = requireObject(entry, `List snapshot move ${index}`) as { readonly id?: unknown; readonly position?: unknown };
        const id = requireElementId(record.id, `List snapshot move ${index} id`);
        const position = requireElementId(record.position, `List snapshot move ${index} position`);
        if (!idList.isKnown(id) || idList.has(id)) {
          throw new Error(`List snapshot move ${index} id must be a known, moved element`);
        }
        if (!idList.has(position)) throw new Error(`List snapshot move ${index} position must be visible`);
        return { id: ownId(id), position: ownId(position) };
      });
      positionOf = positionOf.mutate((draft) => {
        for (const { id, position } of moves) {
          if (draft.get(idKey(id)) !== undefined) throw new Error(`Duplicate moved list element: ${idKey(id)}`);
          draft.set(idKey(id), position);
        }
      });
      logicalOf = logicalOf.mutate((draft) => {
        for (const { id, position } of moves) {
          if (draft.get(idKey(position)) !== undefined) throw new Error(`Duplicate list move position: ${idKey(position)}`);
          draft.set(idKey(position), id);
        }
      });
      // A moved element's position must not also be another element's original ID.
      for (const { position } of moves) {
        if (positionOf.get(idKey(position)) !== undefined) {
          throw new Error(`List move position is also a moved element: ${idKey(position)}`);
        }
      }
    }

    const valuesById = HamtMap.empty<T>().mutate((draft) => {
      let index = 0;
      for (const position of idList) {
        draft.set(idKey(logicalOf.get(idKey(position)) ?? position), snapshot.values[index++]!);
      }
    });
    return new ListState(idList, valuesById, positionOf, logicalOf);
  }

  get length(): number {
    return this.idList.length;
  }

  get(index: number): T {
    return this.valueFor(this.logicalAt(index));
  }

  /** The permanent ID of the element at `index`: the target of set, delete and move. */
  logicalAt(index: number): Readonly<ElementId> {
    return this.logicalFor(this.idList.at(index));
  }

  /** The position ID at `index`: an insertion anchor. */
  positionAt(index: number): ElementId {
    return this.idList.at(index);
  }

  /** Whether the element is visible, as opposed to unknown or deleted. */
  has(id: Readonly<ElementId>): boolean {
    return this.idList.has(this.positionFor(id));
  }

  /** Whether an element or position ID is known, visible or as a tombstone. */
  knows(id: Readonly<ElementId>): boolean {
    return this.idList.isKnown(id);
  }

  cursorAt(index: number, bind?: Cursor["bind"]): Cursor {
    return cursorAt(this.idList, index, bind);
  }

  cursorIndex(cursor: Cursor): number | undefined {
    return cursorIndex(this.idList, cursor);
  }

  insert(operation: ListInsertOperation<string, T>): ListState<T> {
    if (
      operation.before !== null &&
      !this.idList.isKnown(operation.before)
    ) {
      throw new CollectionConflictError(
        `Unknown list insertion anchor: ${idKey(operation.before)}`
      );
    }
    if (this.idList.isKnown(operation.id)) {
      throw new CollectionConflictError(`Duplicate list element id: ${idKey(operation.id)}`);
    }

    const nextIdList = this.idList.insertAfter(operation.before, operation.id);
    const nextValues = this.valuesById.set(idKey(operation.id), operation.value);
    return new ListState(nextIdList, nextValues, this.positionOf, this.logicalOf);
  }

  delete(operation: ListDeleteOperation): ListState<T> {
    this.requireTarget(operation.id);
    const position = this.positionFor(operation.id);
    if (!this.idList.has(position)) return this;

    const key = idKey(operation.id);
    const moved = this.positionOf.get(key) !== undefined;
    return new ListState(this.idList.delete(position), this.valuesById.delete(key),
      moved ? this.positionOf.delete(key) : this.positionOf,
      moved ? this.logicalOf.delete(idKey(position)) : this.logicalOf);
  }

  set(operation: ListSetOperation<string, T>): ListState<T> {
    this.requireTarget(operation.id);
    if (!this.has(operation.id) || Object.is(this.valueFor(operation.id), operation.value)) return this;

    return new ListState(this.idList, this.valuesById.set(idKey(operation.id), operation.value),
      this.positionOf, this.logicalOf);
  }

  /**
   * Inserts the new position after `before` and, when the element is visible, retires its old position.
   * Moving a deleted element still records the position, as a tombstone, so later anchors resolve.
   */
  move(operation: ListMoveOperation): ListState<T> {
    if (operation.before !== null && !this.idList.isKnown(operation.before)) {
      throw new CollectionConflictError(`Unknown list move anchor: ${idKey(operation.before)}`);
    }
    if (this.idList.isKnown(operation.position)) {
      throw new CollectionConflictError(`Duplicate list element id: ${idKey(operation.position)}`);
    }
    this.requireTarget(operation.id);
    const inserted = this.idList.insertAfter(operation.before, operation.position);
    if (!this.has(operation.id)) {
      return new ListState(inserted.delete(operation.position), this.valuesById, this.positionOf, this.logicalOf);
    }
    const key = idKey(operation.id);
    const previous = this.positionFor(operation.id);
    const position = ownId(operation.position);
    return new ListState(inserted.delete(previous), this.valuesById,
      this.positionOf.set(key, position),
      this.logicalOf.delete(idKey(previous)).set(idKey(position), ownId(operation.id)));
  }

  *values(): IterableIterator<T> {
    if (this.logicalOf.size === 0) {
      for (const id of this.idList) yield this.valueFor(id);
      return;
    }
    for (const position of this.idList) yield this.valueFor(this.logicalFor(position));
  }

  toArray(): T[] {
    return [...this.values()];
  }

  visibleValueEquals(other: ListState<T>, id: Readonly<ElementId>): boolean {
    const present = this.has(id);
    if (present !== other.has(id)) return false;
    return !present || Object.is(this.valueFor(id), other.valueFor(id));
  }

  /** Same elements, by permanent ID, in the same order with the same values. */
  visibleEquals(other: ListState<T>): boolean {
    if (this === other) return true;
    if (this.length !== other.length) return false;

    const left = this.idList.values();
    const right = other.idList.values();
    while (true) {
      const leftNext = left.next();
      const rightNext = right.next();
      if (leftNext.done || rightNext.done) {
        return leftNext.done === rightNext.done;
      }
      const leftId = this.logicalFor(leftNext.value), rightId = other.logicalFor(rightNext.value);
      if (!equalsId(leftId, rightId)) return false;
      if (!Object.is(this.valueFor(leftId), other.valueFor(rightId))) return false;
    }
  }

  /** The two states differ only by applying one move of this permanent ID. */
  singleMoveVisibleEquals(other: ListState<T>, id: Readonly<ElementId>): boolean {
    return !this.has(id) || this.indexOf(id) === other.indexOf(id);
  }

  /** Describes the same single-move transition to a subscriber with a matching baseline. */
  singleMoveChangesTo(other: ListState<T>, id: Readonly<ElementId>): ListChangeEvent<T> {
    if (!this.has(id)) return listChangeEvent<T>(this.length, other.length, []);
    const from = this.indexOf(id), to = other.indexOf(id);
    const moves = from === to ? [] : [moveChange(from, to, this.valueFor(id))];
    return listChangeEvent<T>(this.length, other.length, [], moves);
  }

  /**
   * Visible changes to a later state. With targets, every other element must keep its ID, value
   * and relative order on both sides; inconsistent targets fall back to the full comparison.
   */
  changesTo(other: ListState<T>, targets?: Iterable<Readonly<ElementId>>): ListChangeEvent<T> {
    if (this === other) return listChangeEvent<T>(this.length, other.length, []);
    if (targets === undefined) return this.fullChangesTo(other);

    const seen = new Set<string>();
    const removed: Array<{ index: number; value: T }> = [];
    const inserted: Array<{ index: number; value: T }> = [];
    const changes: IndexedChange<T>[] = [];
    for (const id of targets) {
      const key = idKey(id);
      if (seen.has(key)) continue;
      seen.add(key);
      const before = this.has(id), after = other.has(id);
      if (before && after) {
        const value = other.valueFor(id);
        if (!Object.is(this.valueFor(id), value)) changes.push(setChange(this.indexOf(id), value));
      } else if (before) {
        removed.push({ index: this.indexOf(id), value: this.valueFor(id) });
      } else if (after) {
        inserted.push({ index: other.indexOf(id), value: other.valueFor(id) });
      }
    }
    removed.sort((a, b) => a.index - b.index);
    inserted.sort((a, b) => a.index - b.index);
    // Untouched and still-present elements align on both sides; replace removed/inserted runs between them.
    let left = 0, right = 0, beforeIndex = 0, afterIndex = 0;
    let lengthChanged = false;
    while (left < removed.length || right < inserted.length) {
      const gap = Math.min((removed[left]?.index ?? this.length) - beforeIndex,
        (inserted[right]?.index ?? other.length) - afterIndex);
      if (gap < 0) return this.fullChangesTo(other);
      beforeIndex += gap; afterIndex += gap;
      const index = beforeIndex, gone: T[] = [], insert: T[] = [];
      while (removed[left]?.index === beforeIndex) { gone.push(removed[left++]!.value); beforeIndex++; }
      while (inserted[right]?.index === afterIndex) { insert.push(inserted[right++]!.value); afterIndex++; }
      if (gone.length === 0 && insert.length === 0) return this.fullChangesTo(other);
      if (gone.length !== insert.length) lengthChanged = true;
      if (gone.length !== insert.length || gone.some((value, offset) => !Object.is(value, insert[offset]))) {
        changes.push(spliceChange(index, gone.length, insert));
      }
    }
    if (this.length - beforeIndex !== other.length - afterIndex) return this.fullChangesTo(other);
    if (lengthChanged && this.length === other.length && changes.every((change) => change.type === "splice")) {
      // Equal totals with uneven runs (a delete plus an insert elsewhere) may only shift equal values.
      // Elements outside the edited span are unchanged, so comparing that span decides silence.
      let low = this.length, high = 0;
      for (const change of changes) {
        low = Math.min(low, change.index);
        if (change.type === "splice") high = Math.max(high, change.index + change.deleteCount);
      }
      let same = true;
      for (let index = low; same && index < high; index++) same = Object.is(this.get(index), other.get(index));
      if (same) return listChangeEvent<T>(this.length, other.length, []);
    }
    return listChangeEvent(this.length, other.length, changes);
  }

  /** Permanent IDs in visible order. */
  private logicalIds(): Readonly<ElementId>[] {
    return [...this.idList].map((position) => this.logicalFor(position));
  }

  /** Without moves: same-ID prefix/suffix become sets and the middle one value-trimmed splice. */
  private fullChangesTo(other: ListState<T>): ListChangeEvent<T> {
    const beforeIds = this.logicalIds(), afterIds = other.logicalIds();
    if (reordered(beforeIds, afterIds)) return this.movedChangesTo(other, beforeIds, afterIds);
    const changes: IndexedChange<T>[] = [];
    let start = 0;
    while (start < beforeIds.length && start < afterIds.length && equalsId(beforeIds[start]!, afterIds[start]!)) {
      const value = other.valueFor(afterIds[start]!);
      if (!Object.is(this.valueFor(beforeIds[start]!), value)) changes.push(setChange(start, value));
      start++;
    }
    let endBefore = beforeIds.length, endAfter = afterIds.length;
    while (endBefore > start && endAfter > start && equalsId(beforeIds[endBefore - 1]!, afterIds[endAfter - 1]!)) {
      endBefore--; endAfter--;
      const value = other.valueFor(afterIds[endAfter]!);
      if (!Object.is(this.valueFor(beforeIds[endBefore]!), value)) changes.push(setChange(endBefore, value));
    }
    // Different IDs with identical values at the middle's edges are not visible content changes.
    while (start < endBefore && start < endAfter &&
      Object.is(this.valueFor(beforeIds[start]!), other.valueFor(afterIds[start]!))) start++;
    while (endBefore > start && endAfter > start &&
      Object.is(this.valueFor(beforeIds[endBefore - 1]!), other.valueFor(afterIds[endAfter - 1]!))) {
      endBefore--; endAfter--;
    }
    if (endBefore > start || endAfter > start) {
      changes.push(spliceChange(start, endBefore - start,
        afterIds.slice(start, endAfter).map((id) => other.valueFor(id))));
    }
    return listChangeEvent(this.length, other.length, changes);
  }

  /**
   * With moves: first move the elements outside the longest run of survivors already in order,
   * each in its final order, so survivors line up; then remove, insert and set like a merge.
   */
  private movedChangesTo(
    other: ListState<T>, beforeIds: readonly Readonly<ElementId>[], afterIds: readonly Readonly<ElementId>[]
  ): ListChangeEvent<T> {
    const afterIndex = new Map(afterIds.map((id, index) => [idKey(id), index]));
    const beforeKeys = new Set(beforeIds.map(idKey));
    const survivors = beforeIds.filter((id) => afterIndex.has(idKey(id)));
    const stay = longestIncreasing(survivors.map((id) => afterIndex.get(idKey(id))!)).map((at) => idKey(survivors[at]!));
    const placed = new Set(stay);
    const working = [...beforeIds];
    const moves: ListChange<T>[] = [];
    for (const id of afterIds) {
      const key = idKey(id);
      if (!beforeKeys.has(key) || placed.has(key)) continue;
      const from = working.findIndex((entry) => idKey(entry) === key);
      working.splice(from, 1);
      // After the nearest earlier survivor that is already in place, or first.
      let to = 0;
      for (let at = afterIndex.get(key)! - 1; at >= 0; at--) {
        const previous = idKey(afterIds[at]!);
        if (!placed.has(previous)) continue;
        to = working.findIndex((entry) => idKey(entry) === previous) + 1;
        break;
      }
      working.splice(to, 0, id);
      placed.add(key);
      moves.push(moveChange(from, to, this.valueFor(id)));
    }
    // Survivors now share one order; merge the rest in working coordinates.
    const changes: IndexedChange<T>[] = [];
    let i = 0, j = 0;
    while (i < working.length || j < afterIds.length) {
      const start = i, gone: number[] = [], insert: T[] = [];
      while (i < working.length && !afterIndex.has(idKey(working[i]!))) { gone.push(i); i++; }
      while (j < afterIds.length && !beforeKeys.has(idKey(afterIds[j]!))) { insert.push(other.valueFor(afterIds[j]!)); j++; }
      if (gone.length > 0 || insert.length > 0) changes.push(spliceChange(start, gone.length, insert));
      if (i < working.length && j < afterIds.length) {
        const value = other.valueFor(afterIds[j]!);
        if (!Object.is(this.valueFor(working[i]!), value)) changes.push(setChange(i, value));
        i++; j++;
      }
    }
    return listChangeEvent(this.length, other.length, changes, moves);
  }

  save(): ListSnapshotData<T> {
    const idList = Object.freeze(
      this.idList.save().map((range) => Object.freeze({ ...range }))
    );
    const values = Object.freeze(this.toArray());
    if (this.positionOf.size === 0) return Object.freeze({ idList, values });
    const moves: ListMoveEntry[] = [];
    for (const position of this.idList) {
      const id = this.logicalOf.get(idKey(position));
      if (id !== undefined) moves.push(Object.freeze({ id, position: ownId(position) }));
    }
    return Object.freeze({ idList, values, moves: Object.freeze(moves) });
  }

  /**
   * Set, delete and move name an element by its permanent ID. A visible move position is not one:
   * targeting it would detach the moved element from its value, so it is as unknown as any other ID.
   * A retired position is a known tombstone, so naming it is a harmless no-op.
   */
  private requireTarget(id: Readonly<ElementId>): void {
    if (!this.idList.isKnown(id) || (this.logicalOf.size !== 0 && this.logicalOf.get(idKey(id)) !== undefined)) {
      throw new CollectionConflictError(`Unknown list element id: ${idKey(id)}`);
    }
  }

  // Lists that never moved an element skip the lookups, and their key strings, entirely.
  /** Where a known element sits, or its last position if deleted. */
  positionFor(id: Readonly<ElementId>): Readonly<ElementId> {
    return this.positionOf.size === 0 ? id : this.positionOf.get(idKey(id)) ?? id;
  }

  private logicalFor(position: Readonly<ElementId>): Readonly<ElementId> {
    return this.logicalOf.size === 0 ? position : this.logicalOf.get(idKey(position)) ?? position;
  }

  private indexOf(id: Readonly<ElementId>): number {
    return this.idList.indexOf(this.positionFor(id));
  }

  /** The value of a visible element. */
  valueFor(id: Readonly<ElementId>): T {
    const key = idKey(id);
    const value = this.valuesById.get(key);
    if (value === undefined) {
      throw new Error(`Missing value for list element id: ${key}`);
    }
    return value;
  }
}

/** Whether the elements both lists contain appear in a different relative order. */
function reordered(before: readonly Readonly<ElementId>[], after: readonly Readonly<ElementId>[]): boolean {
  const afterKeys = new Set(after.map(idKey)), beforeKeys = new Set(before.map(idKey));
  const left = before.filter((id) => afterKeys.has(idKey(id)));
  const right = after.filter((id) => beforeKeys.has(idKey(id)));
  return left.some((id, index) => !equalsId(id, right[index]!));
}

/** Indices of one longest strictly increasing subsequence, in order. O(n log n). */
function longestIncreasing(values: readonly number[]): number[] {
  const tails: number[] = [], previous = new Array<number>(values.length).fill(-1);
  for (const [index, value] of values.entries()) {
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]!]! < value) low = middle + 1; else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const result: number[] = [];
  for (let at = tails.at(-1) ?? -1; at !== -1; at = previous[at]!) result.push(at);
  return result.reverse();
}

export function freezeListOperation<
  Path extends string,
  T extends JsonValue,
>(operation: ListInsertOperation<Path, T>): ListInsertOperation<Path, T>;
export function freezeListOperation<Path extends string>(
  operation: ListDeleteOperation<Path>
): ListDeleteOperation<Path>;
export function freezeListOperation<Path extends string, T extends JsonValue>(
  operation: ListSetOperation<Path, T>
): ListSetOperation<Path, T>;
export function freezeListOperation<Path extends string>(
  operation: ListMoveOperation<Path>
): ListMoveOperation<Path>;
export function freezeListOperation<
  Path extends string,
  T extends JsonValue,
>(operation: ListOperation<Path, T>): ListOperation<Path, T>;
export function freezeListOperation<
  Path extends string,
  T extends JsonValue,
>(operation: ListOperation<Path, T>): ListOperation<Path, T> {
  if (operation.type === "list/insert") {
    return Object.freeze({
      type: operation.type,
      path: operation.path,
      before: operation.before === null ? null : ownId(operation.before),
      id: ownId(operation.id),
      value: operation.value,
    });
  }
  if (operation.type === "list/set") {
    return Object.freeze({ type: operation.type, path: operation.path,
      id: ownId(operation.id), value: operation.value });
  }
  if (operation.type === "list/move") {
    return Object.freeze({ type: operation.type, path: operation.path, id: ownId(operation.id),
      before: operation.before === null ? null : ownId(operation.before), position: ownId(operation.position) });
  }
  return Object.freeze({
    type: operation.type,
    path: operation.path,
    id: ownId(operation.id),
  });
}

/** Internal mutable API wrapper around a persistent ListState. */
export class RuntimeList<T extends JsonValue> implements List<T> {
  private current: ListState<T>;
  private readonly path: string;
  private readonly mutate: (operation: ListOperation<string, T>) => void;
  private readonly idGenerator: ElementIdGenerator;
  private readonly beforeMutation: () => void;
  private bunchSeq: number;
  private readonly observers: CollectionObservers<ListState<T>, ListChangeEvent<T>, Readonly<ElementId>>;
  private readonly payload: PayloadSchema | undefined;

  constructor(
    mutate: (operation: ListOperation<string, T>) => void,
    clientId: string,
    path: string,
    initialState: ListState<T>,
    beforeMutation: () => void,
    lastBunchSeq: number,
    beforeObserve: () => () => void,
    payload?: PayloadSchema
  ) {
    this.mutate = mutate;
    this.path = path;
    this.current = initialState;
    this.payload = payload;

    this.beforeMutation = beforeMutation;
    this.observers = new CollectionObservers(() => this.current, beforeObserve, elementTargets);
    this.bunchSeq = lastBunchSeq;
    this.idGenerator = new ElementIdGenerator(() => {
      if (this.bunchSeq === Number.MAX_SAFE_INTEGER) {
        throw new Error("ID bunch sequence exhausted");
      }
      return JSON.stringify([clientId, path, ++this.bunchSeq]);
    });
  }

  get lastBunchSeq(): number {
    return this.bunchSeq;
  }

  get state(): ListState<T> {
    return this.current;
  }

  get length(): number {
    return this.current.length;
  }

  get(index: number): T {
    requireNumber(index, "Index");
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Index out of bounds: ${index} (length: ${this.length})`);
    }
    return this.current.get(index);
  }

  set(index: number, value: T): void {
    requireNumber(index, "Index");
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Index out of bounds: ${index} (length: ${this.length})`);
    }

    this.beforeMutation();
    validateJsonValue(value, [this.path]);
    checkPayload(this.payload, value, [this.path]);
    const operation = freezeListOperation({
      type: "list/set", path: this.path, id: this.current.logicalAt(index), value,
    });
    this.current = this.current.set(operation);
    this.mutate(operation);
  }

  insert(index: number, value: T): void {
    requireNumber(index, "Index");
    if (!Number.isSafeInteger(index) || index < 0 || index > this.length) {
      throw new RangeError(`Index out of bounds: ${index} (length: ${this.length})`);
    }

    this.beforeMutation();
    validateJsonValue(value, [this.path]);
    checkPayload(this.payload, value, [this.path]);
    const before = index === 0 ? null : this.current.positionAt(index - 1);
    const operation = freezeListOperation({
      type: "list/insert",
      path: this.path,
      before,
      id: this.idGenerator.generateAfter(before),
      value,
    });
    this.current = this.current.insert(operation);
    this.mutate(operation);
  }

  push(value: T): void {
    this.insert(this.length, value);
  }

  delete(index: number): void {
    requireNumber(index, "Index");
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Index out of bounds: ${index} (length: ${this.length})`);
    }

    this.beforeMutation();
    const operation = freezeListOperation({
      type: "list/delete",
      path: this.path,
      id: this.current.logicalAt(index),
    });
    this.current = this.current.delete(operation);
    this.mutate(operation);
  }

  move(from: number, to: number): void {
    for (const [name, index] of [["from", from], ["to", to]] as const) {
      requireNumber(index, name);
      if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
        throw new RangeError(`Index out of bounds: ${name} ${index} (length: ${this.length})`);
      }
    }
    if (from === to) return;

    this.beforeMutation();
    // The anchor is the element that will precede it once it is taken out of the list.
    const anchorIndex = to - 1 < from ? to - 1 : to;
    const before = to === 0 ? null : this.current.positionAt(anchorIndex);
    const operation = freezeListOperation({
      type: "list/move",
      path: this.path,
      id: this.current.logicalAt(from),
      before,
      position: this.idGenerator.generateAfter(before),
    });
    this.current = this.current.move(operation);
    this.mutate(operation);
  }

  /** ID-targeted writes for the undo manager; each records one operation like the index-based API. */
  [historyWriter]() {
    const write = (operation: ListOperation<string, T>, apply: (state: ListState<T>) => ListState<T>) => {
      this.current = apply(this.current);
      this.mutate(operation);
    };
    return {
      /** Inserts `value` right after the `before` position, which may be a tombstone; returns its new ID. */
      insertAfter: (before: Readonly<ElementId> | null, value: T): Readonly<ElementId> => {
        this.beforeMutation();
        validateJsonValue(value, [this.path]);
        checkPayload(this.payload, value, [this.path]);
        const operation = freezeListOperation({ type: "list/insert", path: this.path, before,
          id: this.idGenerator.generateAfter(before), value });
        write(operation, (state) => state.insert(operation));
        return operation.id;
      },
      delete: (id: Readonly<ElementId>): void => {
        this.beforeMutation();
        const operation = freezeListOperation({ type: "list/delete", path: this.path, id });
        write(operation, (state) => state.delete(operation));
      },
      set: (id: Readonly<ElementId>, value: T): void => {
        this.beforeMutation();
        validateJsonValue(value, [this.path]);
        checkPayload(this.payload, value, [this.path]);
        const operation = freezeListOperation({ type: "list/set", path: this.path, id, value });
        write(operation, (state) => state.set(operation));
      },
      /** Moves the element to right after the `before` position, which may be a tombstone; returns its new position. */
      moveAfter: (id: Readonly<ElementId>, before: Readonly<ElementId> | null): Readonly<ElementId> => {
        this.beforeMutation();
        const operation = freezeListOperation({ type: "list/move", path: this.path, id, before,
          position: this.idGenerator.generateAfter(before) });
        write(operation, (state) => state.move(operation));
        return operation.position;
      },
    };
  }

  values(): IterableIterator<T> {
    return this.current.values();
  }

  toArray(): T[] {
    return this.current.toArray();
  }

  cursorAt(index: number, bind?: Cursor["bind"]): Cursor {
    return this.current.cursorAt(index, bind);
  }

  cursorIndex(cursor: Cursor): number | undefined {
    return this.current.cursorIndex(cursor);
  }

  observe(listener: (event: ListChangeEvent<T>) => void): () => void {
    return this.observers.observe(listener);
  }

  /** Inserts, sets and deletes change at most their own element; a move reorders the List. */
  track(operation: ListOperation): void {
    if (operation.type === "list/move") this.observers.requireFullComparison();
    else this.observers.track([operation.id]);
  }

  requireFullComparison(): void {
    this.observers.requireFullComparison();
  }

  get hasPendingObservers(): boolean {
    return this.observers.hasPending;
  }

  flushObservers(): void {
    this.observers.flush();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }

  restore(state: ListState<T>, singleMoveId?: Readonly<ElementId>): void {
    const previous = this.current;
    this.current = state;
    if (singleMoveId !== undefined && this.observers.hasPending) {
      const id = ownId(singleMoveId);
      this.observers.requireFullComparison((before, after) =>
        before === previous && after === state ? before.singleMoveChangesTo(after, id) : undefined);
    }
  }

  visibleEquals(state: ListState<T>): boolean {
    return this.current.visibleEquals(state);
  }
}
