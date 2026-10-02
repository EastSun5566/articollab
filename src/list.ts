import {
  ElementIdGenerator,
  equalsId,
  IdList,
  type ElementId,
  type SavedIdList,
} from "articulated";

import type { JsonValue } from "./schema.ts";
import { CollectionConflictError } from "./conflict.ts";

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

export type ListOperation<
  Path extends string = string,
  T extends JsonValue = JsonValue,
> = ListInsertOperation<Path, T> | ListDeleteOperation<Path>;

/** An optimistic collaborative list of immutable values. */
export interface List<T extends JsonValue> extends Iterable<T> {
  readonly length: number;
  get(index: number): T;
  insert(index: number, value: T): void;
  push(value: T): void;
  delete(index: number): void;
  values(): IterableIterator<T>;
  toArray(): T[];
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
    const object = requireObject(
      range,
      `${name} entry ${index}`
    ) as SavedIdRange;
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
  private readonly valuesById: ReadonlyMap<string, T>;

  private constructor(
    idList: IdList,
    valuesById: ReadonlyMap<string, T>
  ) {
    this.idList = idList;
    this.valuesById = valuesById;
  }

  static empty<T extends JsonValue>(): ListState<T> {
    return new ListState(IdList.new(), new Map());
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

    const valuesById = new Map<string, T>();
    let index = 0;
    for (const id of idList) {
      valuesById.set(idKey(id), data.values[index++]!);
    }
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
    const nextValues = new Map(this.valuesById);
    nextValues.set(idKey(operation.id), operation.value);
    return new ListState(nextIdList, nextValues);
  }

  delete(operation: ListDeleteOperation): ListState<T> {
    if (!this.idList.isKnown(operation.id)) {
      throw new CollectionConflictError(`Unknown list element id: ${idKey(operation.id)}`);
    }
    if (!this.idList.has(operation.id)) return this;

    const nextValues = new Map(this.valuesById);
    nextValues.delete(idKey(operation.id));
    return new ListState(this.idList.delete(operation.id), nextValues);
  }

  *values(): IterableIterator<T> {
    for (const id of this.idList) yield this.valueFor(id);
  }

  toArray(): T[] {
    return [...this.values()];
  }

  visibleEquals(other: ListState<T>): boolean {
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

  constructor(
    mutate: (operation: ListOperation<string, T>) => void,
    clientId: string,
    path: string,
    initialState: ListState<T>,
    beforeMutation: () => void,
    lastBunchSeq = 0
  ) {
    this.mutate = mutate;
    this.path = path;
    this.current = initialState;

    this.beforeMutation = beforeMutation;
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

  insert(index: number, value: T): void {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.length) {
      throw new Error(`Index out of bounds: ${index} (length: ${this.length})`);
    }

    this.beforeMutation();
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
