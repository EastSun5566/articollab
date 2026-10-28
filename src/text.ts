import {
  ElementIdGenerator,
  equalsId,
  IdList,
  type ElementId,
} from "articulated";

import { loadIdList, type SavedIdRange } from "./list.ts";
import { CollectionConflictError } from "./conflict.ts";
import { HamtMap } from "./vendor/hamt.ts";
import { jsonArray, jsonPointer, type JsonPathSegment } from "./json.ts";
import { CollectionObservers } from "./observe.ts";
import { cursorAt, cursorIndex, type Cursor } from "./cursor.ts";

export interface TextSnapshotData {
  readonly idList: readonly SavedIdRange[];
  readonly value: string;
  /** UTF-16 offsets where adjacent surrogate halves belong to separate elements. */
  readonly surrogateBoundaries?: readonly number[];
}

type BoundaryFailure = (path: readonly JsonPathSegment[], message: string) => never;

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function snapshotElements(value: string, input: unknown, fail: BoundaryFailure): string[] {
  const boundaries = jsonArray(input, [], "Text snapshot surrogateBoundaries", fail);
  if (boundaries.length === 0) fail([], "surrogateBoundaries must not be empty");
  const values: string[] = [];
  let start = 0;
  for (const [index, offset] of boundaries.entries()) {
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) ||
      offset <= start || offset >= value.length) {
      fail([index], "boundary must be an increasing safe integer within the string");
    }
    if (!isHighSurrogate(value.charCodeAt(offset - 1)) || !isLowSurrogate(value.charCodeAt(offset))) {
      fail([index], "boundary must separate a high and low surrogate");
    }
    for (const element of value.slice(start, offset)) values.push(element);
    start = offset;
  }
  for (const element of value.slice(start)) values.push(element);
  return values;
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

export interface TextChange {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: readonly string[];
}

export interface TextChangeEvent {
  readonly beforeLength: number;
  readonly afterLength: number;
  readonly changes: readonly TextChange[];
}

/** An optimistic collaborative plain-text string indexed by Unicode code point. */
export interface Text extends Iterable<string> {
  readonly length: number;
  insert(index: number, value: string): void;
  delete(index: number, count?: number): void;
  values(): IterableIterator<string>;
  toString(): string;
  /** Subscribes from the current view; changes use descending pre-event element offsets. */
  observe(listener: (event: TextChangeEvent) => void): () => void;
  /** A stable position for the gap before element `index`; "left" binds to the element before it. */
  cursorAt(index: number, bind?: "left" | "right"): Cursor;
  /** The cursor's current element index, or undefined while its anchor is not known here. */
  cursorIndex(cursor: Cursor): number | undefined;
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
    start.counter > Number.MAX_SAFE_INTEGER - count + 1
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
  private readonly valuesById: HamtMap<string>;

  private constructor(
    idList: IdList,
    valuesById: HamtMap<string>
  ) {
    this.idList = idList;
    this.valuesById = valuesById;
  }

  static empty(): TextState {
    return new TextState(IdList.new(), HamtMap.empty<string>());
  }

  static load(snapshot: TextSnapshotData, failBoundary: BoundaryFailure = (path, message) => {
    throw new Error(`Invalid Text snapshot surrogateBoundaries at ${jsonPointer(path)}: ${message}`);
  }): TextState {
    const data = requireObject(snapshot, "Text snapshot") as Partial<
      TextSnapshotData
    >;
    if (!Array.isArray(data.idList)) {
      throw new Error("Text snapshot idList must be an array");
    }
    if (typeof data.value !== "string") {
      throw new Error("Text snapshot value must be a string");
    }

    const idList = loadIdList(data.idList, "Text snapshot idList");
    const values = Object.hasOwn(data, "surrogateBoundaries")
      ? snapshotElements(data.value, data.surrogateBoundaries, failBoundary)
      // oxlint-disable-next-line typescript/no-misused-spread -- Unmarked Text uses Unicode code points, not grapheme clusters.
      : [...data.value];
    if (idList.length !== values.length) {
      throw new Error(
        `Text snapshot has ${idList.length} present ids but ${values.length} code points`
      );
    }

    const valuesById = HamtMap.empty<string>().mutate((draft) => {
      let index = 0;
      for (const id of idList) draft.set(idKey(id), values[index++]!);
    });
    return new TextState(idList, valuesById);
  }

  get length(): number {
    return this.idList.length;
  }

  idAt(index: number): ElementId {
    return this.idList.at(index);
  }

  cursorAt(index: number, bind?: Cursor["bind"]): Cursor {
    return cursorAt(this.idList, index, bind);
  }

  cursorIndex(cursor: Cursor): number | undefined {
    return cursorIndex(this.idList, cursor);
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
      throw new CollectionConflictError(
        `Unknown text insertion anchor: ${idKey(operation.before)}`
      );
    }

    // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
    const values = [...operation.value];
    const ids = [...idsInRange(operation.id, values.length)];
    for (const id of ids) {
      if (this.idList.isKnown(id)) {
        throw new CollectionConflictError(`Duplicate text element id: ${idKey(id)}`);
      }
    }

    const nextIdList = this.idList.insertAfter(
      operation.before,
      operation.id,
      values.length
    );
    const nextValues = this.valuesById.mutate((draft) => {
      for (let index = 0; index < ids.length; index++) {
        draft.set(idKey(ids[index]!), values[index]!);
      }
    });
    return new TextState(nextIdList, nextValues);
  }

  delete(operation: TextDeleteOperation): TextState {
    const ranges: readonly TextIdRange[] = operation.ranges;
    if (!Array.isArray(operation.ranges) || operation.ranges.length === 0) {
      throw new Error("Text delete ranges must not be empty");
    }

    for (const range of ranges) {
      for (const id of idsInRange(range.start, range.count)) {
        if (!this.idList.isKnown(id)) {
          throw new CollectionConflictError(`Unknown text element id: ${idKey(id)}`);
        }
      }
    }

    let nextIdList = this.idList;
    const nextValues = this.valuesById.mutate((draft) => {
      for (const range of ranges) {
        nextIdList = nextIdList.delete(range.start, range.count);
        for (const id of idsInRange(range.start, range.count)) {
          draft.delete(idKey(id));
        }
      }
    });
    // All targets were already tombstones; preserve identity for visible equality.
    if (nextIdList.length === this.idList.length) return this;
    return new TextState(nextIdList, nextValues);
  }

  *values(): IterableIterator<string> {
    for (const id of this.idList) yield this.valueFor(id);
  }

  toString(): string {
    return [...this.values()].join("");
  }

  /** Removing all targets must leave the same ordered elements on both sides. */
  changesTo(other: TextState, targets?: Iterable<Readonly<ElementId>>): TextChangeEvent {
    const changes: TextChange[] = [];
    const result = () => Object.freeze({ beforeLength: this.length,
      afterLength: other.length, changes: Object.freeze(changes.reverse()) });
    if (this === other) return result();

    if (targets === undefined) {
      const before = [...this.values()], after = [...other.values()];
      let start = 0, endBefore = before.length, endAfter = after.length;
      while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
      while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
        endBefore--; endAfter--;
      }
      if (endBefore !== start || endAfter !== start) changes.push(Object.freeze({
        index: start, deleteCount: endBefore - start, insert: Object.freeze(after.slice(start, endAfter)),
      }));
      return result();
    }

    const before: Array<{ index: number; value: string }> = [];
    const after: Array<{ index: number; value: string }> = [];
    for (const id of targets) {
      if (this.idList.has(id)) before.push({ index: this.idList.indexOf(id), value: this.valueFor(id) });
      if (other.idList.has(id)) after.push({ index: other.idList.indexOf(id), value: other.valueFor(id) });
    }
    before.sort((a, b) => a.index - b.index);
    after.sort((a, b) => a.index - b.index);
    // Skip untouched gaps, then replace adjacent target runs in original coordinates.
    let left = 0, right = 0, beforeIndex = 0, afterIndex = 0;
    while (left < before.length || right < after.length) {
      const gap = Math.min((before[left]?.index ?? this.length) - beforeIndex,
        (after[right]?.index ?? other.length) - afterIndex);
      if (gap < 0) return this.changesTo(other);
      beforeIndex += gap; afterIndex += gap;
      const index = beforeIndex, removed: string[] = [], insert: string[] = [];
      while (before[left]?.index === beforeIndex) {
        removed.push(before[left++]!.value); beforeIndex++;
      }
      while (after[right]?.index === afterIndex) {
        insert.push(after[right++]!.value); afterIndex++;
      }
      if (removed.length === 0 && insert.length === 0) return this.changesTo(other);
      if (removed.length !== insert.length || removed.some((value, offset) => value !== insert[offset])) {
        changes.push(Object.freeze({ index, deleteCount: removed.length, insert: Object.freeze(insert) }));
      }
    }
    if (this.length - beforeIndex !== other.length - afterIndex) return this.changesTo(other);
    // Equal-length edits at different offsets can merely redistribute identical characters.
    if (this.length === other.length && changes.some((change) => change.deleteCount !== change.insert.length)) {
      return this.changesTo(other);
    }
    return result();
  }

  /** Requires complete replay on both sides, with differences confined to these targets. */
  visibleEqualsAt(other: TextState, operations: readonly TextOperation[]): boolean {
    if (this === other) return true;
    if (this.length !== other.length) return false;

    const sameValue = (id: Readonly<ElementId>): boolean => {
      const present = this.idList.has(id);
      if (present !== other.idList.has(id)) return false;
      return !present || this.valueFor(id) === other.valueFor(id);
    };
    for (const operation of operations) {
      if (operation.type === "text/insert") {
        let counter = operation.id.counter;
        for (const _ of operation.value) {
          if (!sameValue({ bunchId: operation.id.bunchId, counter: counter++ })) return false;
        }
      } else {
        for (const range of operation.ranges) {
          for (const id of idsInRange(range.start, range.count)) {
            if (!sameValue(id)) return false;
          }
        }
      }
    }
    return true;
  }

  visibleEquals(other: TextState): boolean {
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
      if (this.valueFor(leftNext.value) !== other.valueFor(rightNext.value)) {
        return false;
      }
    }
  }

  save(): TextSnapshotData {
    const idList = Object.freeze(
      this.idList.save().map((range) => Object.freeze({ ...range }))
    );
    const values: string[] = [], boundaries: number[] = [];
    let offset = 0, previous = NaN;
    for (const element of this.values()) {
      if (isHighSurrogate(previous) && isLowSurrogate(element.charCodeAt(0))) boundaries.push(offset);
      values.push(element);
      offset += element.length;
      previous = element.charCodeAt(element.length - 1);
    }
    return Object.freeze({ idList, value: values.join(""),
      ...(boundaries.length === 0 ? {} : { surrogateBoundaries: Object.freeze(boundaries) }),
    });
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

/** IDs whose visibility a Text operation can change. */
function* textOperationIds(operation: TextOperation): IterableIterator<Readonly<ElementId>> {
  if (operation.type === "text/insert") {
    let counter = operation.id.counter;
    for (const _ of operation.value) yield { bunchId: operation.id.bunchId, counter: counter++ };
  } else {
    for (const range of operation.ranges) yield* idsInRange(range.start, range.count);
  }
}

/** Internal mutable API wrapper around a persistent TextState. */
export class RuntimeText implements Text {
  private current: TextState;
  private readonly path: string;
  private readonly mutate: (operation: TextOperation) => void;
  private readonly idGenerator: ElementIdGenerator;
  private readonly beforeMutation: () => void;
  private bunchSeq: number;
  private readonly observers: CollectionObservers<TextState, TextChangeEvent>;

  constructor(
    mutate: (operation: TextOperation) => void,
    clientId: string,
    path: string,
    initialState: TextState,
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

    this.beforeMutation();
    const before = index === 0 ? null : this.current.idAt(index - 1);
    const operation = freezeTextOperation({
      type: "text/insert",
      path: this.path,
      before,
      // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
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

    this.beforeMutation();
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

  cursorAt(index: number, bind?: Cursor["bind"]): Cursor {
    return this.current.cursorAt(index, bind);
  }

  cursorIndex(cursor: Cursor): number | undefined {
    return this.current.cursorIndex(cursor);
  }

  observe(listener: (event: TextChangeEvent) => void): () => void {
    return this.observers.observe(listener);
  }

  track(operation: TextOperation): void {
    this.observers.track(textOperationIds(operation));
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
