import {
  ElementIdGenerator,
  equalsId,
  IdList,
  type ElementId,
  type SavedIdList,
} from "articulated";

import type { SavedIdRange } from "./list.ts";

export interface TextSnapshotData {
  readonly idList: readonly SavedIdRange[];
  readonly value: string;
}

export interface TextInsertOperation<Path extends string = string> {
  readonly type: "text/insert";
  readonly path: Path;
  readonly before: Readonly<ElementId> | null;
  readonly id: Readonly<ElementId>;
  readonly value: string;
}

export interface TextIdRange {
  readonly start: Readonly<ElementId>;
  readonly count: number;
}

export interface TextDeleteOperation<Path extends string = string> {
  readonly type: "text/delete";
  readonly path: Path;
  readonly ranges: readonly TextIdRange[];
}

export type TextOperation<Path extends string = string> =
  | TextInsertOperation<Path>
  | TextDeleteOperation<Path>;

/** An optimistic collaborative plain-text string indexed by Unicode code point. */
export interface Text extends Iterable<string> {
  readonly length: number;
  insert(index: number, value: string): void;
  delete(index: number, count?: number): void;
  values(): IterableIterator<string>;
  toString(): string;
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

function* idsInRange(
  start: Readonly<ElementId>,
  count: number
): IterableIterator<ElementId> {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(
      `Text id range count must be a positive safe integer: ${count}`
    );
  }
  if (
    !Number.isSafeInteger(start.counter) ||
    start.counter < 0 ||
    !Number.isSafeInteger(start.counter + count - 1)
  ) {
    throw new Error(`Invalid text id range start: ${idKey(start)}`);
  }

  for (let offset = 0; offset < count; offset++) {
    yield {
      bunchId: start.bunchId,
      counter: start.counter + offset,
    };
  }
}

/** Internal persistent state for one Text collection. */
export class TextState {
  private readonly idList: IdList;
  private readonly valuesById: ReadonlyMap<string, string>;

  private constructor(
    idList: IdList,
    valuesById: ReadonlyMap<string, string>
  ) {
    this.idList = idList;
    this.valuesById = valuesById;
  }

  static empty(): TextState {
    return new TextState(IdList.new(), new Map());
  }

  static load(snapshot: TextSnapshotData): TextState {
    const data = requireObject(snapshot, "Text snapshot") as Partial<
      TextSnapshotData
    >;
    if (!Array.isArray(data.idList)) {
      throw new Error("Text snapshot idList must be an array");
    }
    if (typeof data.value !== "string") {
      throw new Error("Text snapshot value must be a string");
    }

    const saved = data.idList.map((range, index) => {
      const object = requireObject(
        range,
        `Text snapshot idList entry ${index}`
      ) as SavedIdRange;
      return { ...object };
    }) as SavedIdList;
    const idList = IdList.load(saved);
    const values = [...data.value];
    if (idList.length !== values.length) {
      throw new Error(
        `Text snapshot has ${idList.length} present ids but ${values.length} code points`
      );
    }

    const valuesById = new Map<string, string>();
    let index = 0;
    for (const id of idList) {
      valuesById.set(idKey(id), values[index++]!);
    }
    return new TextState(idList, valuesById);
  }

  get length(): number {
    return this.idList.length;
  }

  idAt(index: number): ElementId {
    return this.idList.at(index);
  }

  ids(from: number, count: number): ElementId[] {
    return Array.from({ length: count }, (_, offset) =>
      this.idList.at(from + offset)
    );
  }

  insert(operation: TextInsertOperation): TextState {
    if (typeof operation.value !== "string" || operation.value.length === 0) {
      throw new Error("Text insert value must not be empty");
    }
    if (
      operation.before !== null &&
      !this.idList.isKnown(operation.before)
    ) {
      throw new Error(
        `Unknown text insertion anchor: ${idKey(operation.before)}`
      );
    }

    const values = [...operation.value];
    const ids = [...idsInRange(operation.id, values.length)];
    for (const id of ids) {
      if (this.idList.isKnown(id)) {
        throw new Error(`Duplicate text element id: ${idKey(id)}`);
      }
    }

    const nextIdList = this.idList.insertAfter(
      operation.before,
      operation.id,
      values.length
    );
    const nextValues = new Map(this.valuesById);
    for (let index = 0; index < ids.length; index++) {
      nextValues.set(idKey(ids[index]!), values[index]!);
    }
    return new TextState(nextIdList, nextValues);
  }

  delete(operation: TextDeleteOperation): TextState {
    if (!Array.isArray(operation.ranges) || operation.ranges.length === 0) {
      throw new Error("Text delete ranges must not be empty");
    }

    for (const range of operation.ranges) {
      for (const id of idsInRange(range.start, range.count)) {
        if (!this.idList.isKnown(id)) {
          throw new Error(`Unknown text element id: ${idKey(id)}`);
        }
      }
    }

    let nextIdList = this.idList;
    const nextValues = new Map(this.valuesById);
    for (const range of operation.ranges) {
      nextIdList = nextIdList.delete(range.start, range.count);
      for (const id of idsInRange(range.start, range.count)) {
        nextValues.delete(idKey(id));
      }
    }
    return new TextState(nextIdList, nextValues);
  }

  *values(): IterableIterator<string> {
    for (const id of this.idList) yield this.valueFor(id);
  }

  toString(): string {
    return [...this.values()].join("");
  }

  visibleEquals(other: TextState): boolean {
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
      if (this.valueFor(leftNext.value) !== other.valueFor(rightNext.value)) {
        return false;
      }
    }
  }

  save(): TextSnapshotData {
    const idList = Object.freeze(
      this.idList.save().map((range) => Object.freeze({ ...range }))
    );
    return Object.freeze({ idList, value: this.toString() });
  }

  private valueFor(id: Readonly<ElementId>): string {
    const key = idKey(id);
    const value = this.valuesById.get(key);
    if (value === undefined) {
      throw new Error(`Missing value for text element id: ${key}`);
    }
    return value;
  }
}

export function freezeTextOperation<Path extends string>(
  operation: TextInsertOperation<Path>
): TextInsertOperation<Path>;
export function freezeTextOperation<Path extends string>(
  operation: TextDeleteOperation<Path>
): TextDeleteOperation<Path>;
export function freezeTextOperation<Path extends string>(
  operation: TextOperation<Path>
): TextOperation<Path>;
export function freezeTextOperation<Path extends string>(
  operation: TextOperation<Path>
): TextOperation<Path> {
  if (operation.type === "text/insert") {
    return Object.freeze({
      type: operation.type,
      path: operation.path,
      before: operation.before === null ? null : ownId(operation.before),
      id: ownId(operation.id),
      value: operation.value,
    });
  }

  const ranges = Object.freeze(
    operation.ranges.map((range) =>
      Object.freeze({ start: ownId(range.start), count: range.count })
    )
  );
  return Object.freeze({
    type: operation.type,
    path: operation.path,
    ranges,
  });
}

function compressIds(ids: readonly ElementId[]): TextIdRange[] {
  const ranges: Array<{ start: Readonly<ElementId>; count: number }> = [];
  for (const id of ids) {
    const previous = ranges.at(-1);
    if (
      previous !== undefined &&
      previous.start.bunchId === id.bunchId &&
      previous.start.counter + previous.count === id.counter
    ) {
      previous.count++;
    } else {
      ranges.push({ start: id, count: 1 });
    }
  }
  return ranges;
}

/** Internal mutable API wrapper around a persistent TextState. */
export class RuntimeText implements Text {
  private current: TextState;
  private readonly path: string;
  private readonly mutate: (operation: TextOperation<string>) => void;
  private readonly idGenerator: ElementIdGenerator;

  constructor(
    mutate: (operation: TextOperation<string>) => void,
    clientId: string,
    path: string,
    initialState: TextState
  ) {
    this.mutate = mutate;
    this.path = path;
    this.current = initialState;

    let nextBunchSeq = 1;
    this.idGenerator = new ElementIdGenerator(() =>
      JSON.stringify([clientId, path, nextBunchSeq++])
    );
  }

  get state(): TextState {
    return this.current;
  }

  get length(): number {
    return this.current.length;
  }

  insert(index: number, value: string): void {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.length) {
      throw new Error(`Index out of bounds: ${index} (length: ${this.length})`);
    }
    if (value.length === 0) return;

    const before = index === 0 ? null : this.current.idAt(index - 1);
    const operation = freezeTextOperation({
      type: "text/insert",
      path: this.path,
      before,
      id: this.idGenerator.generateAfter(before, [...value].length),
      value,
    });
    this.current = this.current.insert(operation);
    this.mutate(operation);
  }

  delete(index: number, count = 1): void {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.length) {
      throw new Error(`Index out of bounds: ${index} (length: ${this.length})`);
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Invalid delete count: ${count}`);
    }
    if (count > this.length - index) {
      throw new Error(
        `Delete range out of bounds: ${index} + ${count} (length: ${this.length})`
      );
    }
    if (count === 0) return;

    const operation = freezeTextOperation({
      type: "text/delete",
      path: this.path,
      ranges: compressIds(this.current.ids(index, count)),
    });
    this.current = this.current.delete(operation);
    this.mutate(operation);
  }

  values(): IterableIterator<string> {
    return this.current.values();
  }

  toString(): string {
    return this.current.toString();
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.values();
  }

  restore(state: TextState): void {
    this.current = state;
  }

  visibleEquals(state: TextState): boolean {
    return this.current.visibleEquals(state);
  }
}
