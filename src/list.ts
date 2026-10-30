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
import { CollectionObservers } from "./observe.ts";
import { cursorAt, cursorIndex, type Cursor } from "./cursor.ts";

export interface SavedIdRange {
  readonly bunchId: string;
  readonly startCounter: number;
  readonly count: number;
  readonly isDeleted: boolean;
}

export interface ListSnapshotData<T extends JsonValue = JsonValue> {
  readonly idList: readonly SavedIdRange[];
  readonly values: readonly T[];
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

export type ListOperation<
  Path extends string = string,
  T extends JsonValue = JsonValue,
> = ListInsertOperation<Path, T> | ListDeleteOperation<Path> | ListSetOperation<Path, T>;

/** A visible List edit in pre-event index coordinates. */
export type ListChange<T extends JsonValue = JsonValue> =
  | {
    readonly type: "splice";
    readonly index: number;
    readonly deleteCount: number;
    readonly insert: readonly T[];
  }
  | { readonly type: "set"; readonly index: number; readonly value: T };

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
  values(): IterableIterator<T>;
  toArray(): T[];
  /** Subscribes from the current view; changes use descending pre-event indices, sets first at a tie. */
  observe(listener: (event: ListChangeEvent<T>) => void): () => void;
  /** A stable position for the gap before `index`; "left" binds to the element before it. */
  cursorAt(index: number, bind?: "left" | "right"): Cursor;
  /** The cursor's current index, or undefined while its anchor element is not known here. */
  cursorIndex(cursor: Cursor): number | undefined;
}

/** Descending pre-event indices; at one index a set applies before a splice that may insert there. */
function listChangeEvent<T extends JsonValue>(
  beforeLength: number, afterLength: number, changes: ListChange<T>[]
): ListChangeEvent<T> {
  changes.sort((left, right) => right.index - left.index ||
    (left.type === right.type ? 0 : left.type === "set" ? -1 : 1));
  return Object.freeze({ beforeLength, afterLength, changes: Object.freeze(changes) });
}

function spliceChange<T extends JsonValue>(index: number, deleteCount: number, insert: T[]): ListChange<T> {
  return Object.freeze({ type: "splice", index, deleteCount, insert: Object.freeze(insert) });
}

function setChange<T extends JsonValue>(index: number, value: T): ListChange<T> {
  return Object.freeze({ type: "set", index, value });
}

function idKey(id: Readonly<ElementId>): string {
  return JSON.stringify([id.bunchId, id.counter]);
}

function ownId(id: Readonly<ElementId>): Readonly<ElementId> {
  return Object.freeze({ bunchId: id.bunchId, counter: id.counter });
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

/** Internal persistent state for one List collection. */
export class ListState<T extends JsonValue> {
  private readonly idList: IdList;
  private readonly valuesById: HamtMap<T>;

  private constructor(
    idList: IdList,
    valuesById: HamtMap<T>
  ) {
    this.idList = idList;
    this.valuesById = valuesById;
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

    const valuesById = HamtMap.empty<T>().mutate((draft) => {
      let index = 0;
      for (const id of idList) draft.set(idKey(id), snapshot.values[index++]!);
    });
    return new ListState(idList, valuesById);
  }

  get length(): number {
    return this.idList.length;
  }

  get(index: number): T {
    return this.valueFor(this.idList.at(index));
  }

  idAt(index: number): ElementId {
    return this.idList.at(index);
  }

  /** Whether the element is visible, as opposed to unknown or deleted. */
  has(id: Readonly<ElementId>): boolean {
    return this.idList.has(id);
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
    return new ListState(nextIdList, nextValues);
  }

  delete(operation: ListDeleteOperation): ListState<T> {
    if (!this.idList.isKnown(operation.id)) {
      throw new CollectionConflictError(`Unknown list element id: ${idKey(operation.id)}`);
    }
    if (!this.idList.has(operation.id)) return this;

    const nextValues = this.valuesById.delete(idKey(operation.id));
    return new ListState(this.idList.delete(operation.id), nextValues);
  }

  set(operation: ListSetOperation<string, T>): ListState<T> {
    if (!this.idList.isKnown(operation.id)) {
      throw new CollectionConflictError(`Unknown list element id: ${idKey(operation.id)}`);
    }
    if (!this.idList.has(operation.id) || Object.is(this.valueFor(operation.id), operation.value)) return this;

    return new ListState(this.idList, this.valuesById.set(idKey(operation.id), operation.value));
  }

  *values(): IterableIterator<T> {
    for (const id of this.idList) yield this.valueFor(id);
  }

  toArray(): T[] {
    return [...this.values()];
  }

  visibleValueEquals(other: ListState<T>, id: Readonly<ElementId>): boolean {
    const present = this.idList.has(id);
    if (present !== other.idList.has(id)) return false;
    return !present || Object.is(this.valueFor(id), other.valueFor(id));
  }

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
      if (!equalsId(leftNext.value, rightNext.value)) return false;
      if (
        !Object.is(
          this.valueFor(leftNext.value),
          other.valueFor(rightNext.value)
        )
      ) {
        return false;
      }
    }
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
    const changes: ListChange<T>[] = [];
    for (const id of targets) {
      const key = idKey(id);
      if (seen.has(key)) continue;
      seen.add(key);
      const before = this.idList.has(id), after = other.idList.has(id);
      if (before && after) {
        const value = other.valueFor(id);
        if (!Object.is(this.valueFor(id), value)) changes.push(setChange(this.idList.indexOf(id), value));
      } else if (before) {
        removed.push({ index: this.idList.indexOf(id), value: this.valueFor(id) });
      } else if (after) {
        inserted.push({ index: other.idList.indexOf(id), value: other.valueFor(id) });
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

  /** Same-ID prefix/suffix become sets; the middle becomes one value-trimmed splice. */
  private fullChangesTo(other: ListState<T>): ListChangeEvent<T> {
    const beforeIds = [...this.idList], afterIds = [...other.idList];
    const changes: ListChange<T>[] = [];
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

  save(): ListSnapshotData<T> {
    const idList = Object.freeze(
      this.idList.save().map((range) => Object.freeze({ ...range }))
    );
    const values = Object.freeze(this.toArray());
    return Object.freeze({ idList, values });
  }

  private valueFor(id: Readonly<ElementId>): T {
    const key = idKey(id);
    const value = this.valuesById.get(key);
    if (value === undefined) {
      throw new Error(`Missing value for list element id: ${key}`);
    }
    return value;
  }
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
  private readonly observers: CollectionObservers<ListState<T>, ListChangeEvent<T>>;

  constructor(
    mutate: (operation: ListOperation<string, T>) => void,
    clientId: string,
    path: string,
    initialState: ListState<T>,
    beforeMutation: () => void,
    lastBunchSeq: number,
    beforeObserve: () => () => void
  ) {
    this.mutate = mutate;
    this.path = path;
    this.current = initialState;

    this.beforeMutation = beforeMutation;
    this.observers = new CollectionObservers(() => this.current, beforeObserve);
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
    return this.current.get(index);
  }

  set(index: number, value: T): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new Error(`Index out of bounds: ${index} (length: ${this.length})`);
    }

    this.beforeMutation();
    validateJsonValue(value, [this.path]);
    const operation = freezeListOperation({
      type: "list/set", path: this.path, id: this.current.idAt(index), value,
    });
    this.current = this.current.set(operation);
    this.mutate(operation);
  }

  insert(index: number, value: T): void {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.length) {
      throw new Error(`Index out of bounds: ${index} (length: ${this.length})`);
    }

    this.beforeMutation();
    validateJsonValue(value, [this.path]);
    const before = index === 0 ? null : this.current.idAt(index - 1);
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
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new Error(`Index out of bounds: ${index} (length: ${this.length})`);
    }

    this.beforeMutation();
    const operation = freezeListOperation({
      type: "list/delete",
      path: this.path,
      id: this.current.idAt(index),
    });
    this.current = this.current.delete(operation);
    this.mutate(operation);
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

  /** Every List operation changes at most the visibility or value of its own target ID. */
  track(operation: ListOperation): void {
    this.observers.track([operation.id]);
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

  restore(state: ListState<T>): void {
    this.current = state;
  }

  visibleEquals(state: ListState<T>): boolean {
    return this.current.visibleEquals(state);
  }
}
