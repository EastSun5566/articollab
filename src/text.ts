import {
  ElementIdGenerator,
  equalsId,
  IdList,
  type ElementId,
} from "articulated";

import { loadIdList, type SavedIdRange } from "./list.ts";
import { CollectionConflictError } from "./conflict.ts";
import { HamtMap } from "./vendor/hamt.ts";
import { jsonArray, jsonEquals, jsonPointer, validateJsonValue, type JsonPathSegment } from "./json.ts";
import { CollectionObservers, elementTargets } from "./observe.ts";
import { cursorAt, cursorIndex, requireCursor, type Cursor } from "./cursor.ts";
import { historyWriter } from "./history-access.ts";
import { requireNumber } from "./options.ts";
import {
  addMark, attributesAtKnown, changedIntervals, knownAttributes, gapRank, NO_ATTRIBUTES, sameMarks,
  type TextAttributes, type TextMark,
} from "./marks.ts";
import { checkPayload } from "./payload.ts";
import type { JsonValue, MarkShape, MarkValue } from "./schema.ts";

export interface TextSnapshotData {
  readonly idList: readonly SavedIdRange[];
  readonly value: string;
  /** UTF-16 offsets where adjacent surrogate halves belong to separate elements. */
  readonly surrogateBoundaries?: readonly number[];
  /** Formatting marks in the order they were applied; absent when there are none. */
  readonly marks?: readonly TextMark[];
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

/** Sets mark `key` to `value`, or removes it with `null`, on the elements between two gaps. */
export interface TextMarkOperation<Path extends string = string, K extends string = string, V extends JsonValue = JsonValue> {
  readonly type: "text/mark";
  readonly path: Path;
  readonly start: Cursor;
  readonly end: Cursor;
  readonly key: K;
  readonly value: V | null;
}

/** One mark operation type per key of `M`; none for a Text without marks. */
type TextMarkOperationFor<Path extends string, M extends MarkShape> = {
  [K in keyof M & string]: TextMarkOperation<Path, K, MarkValue<M[K]>>;
}[keyof M & string];

export type TextOperation<Path extends string = string, M extends MarkShape = MarkShape> =
  | TextInsertOperation<Path>
  | TextDeleteOperation<Path>
  | TextMarkOperationFor<Path, M>;

export interface TextChange {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: readonly string[];
}

/** The complete attributes of `count` elements from `index`, after the event's changes. */
export interface TextFormatChange {
  readonly index: number;
  readonly count: number;
  readonly attributes: TextAttributes;
}

export interface TextChangeEvent {
  readonly beforeLength: number;
  readonly afterLength: number;
  readonly changes: readonly TextChange[];
  /** Runs whose attributes changed, and every inserted run, once the Text has marks; absent when empty. */
  readonly formats?: readonly TextFormatChange[];
}

/** One mark's value per key; absent keys are unformatted. */
export type TextAttributesOf<M extends MarkShape> = { readonly [K in keyof M]?: MarkValue<M[K]> };

/** A run of equally formatted text, as in a Quill Delta. */
export interface TextDeltaOp<M extends MarkShape = MarkShape> {
  readonly insert: string;
  readonly attributes?: TextAttributesOf<M>;
}

/** An optimistic collaborative string indexed by Unicode code point, formatted with the marks `M`. */
export interface Text<M extends MarkShape = {}> extends Iterable<string> {
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
  /**
   * Sets mark `key` to `value` on `count` elements from `index`, or removes it with `null`. Text typed
   * at the range's edges later takes the mark as the key's `expand` rule says.
   */
  format<K extends keyof M & string>(index: number, count: number, key: K, value: MarkValue<M[K]> | null): void;
  /** The marks of the element at `index`. */
  attributesAt(index: number): TextAttributesOf<M>;
  /** The visible text as runs of equal attributes. */
  toDelta(): readonly TextDeltaOp<M>[];
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

const NO_MARKS: readonly TextMark[] = Object.freeze([]);

/** A frozen copy of a mark's own fields; checks their shapes, not that the anchors exist. */
function ownMark(input: unknown): TextMark {
  const mark = requireObject(input, "Text mark") as Partial<TextMark>;
  const { start, end, key, value } = mark;
  requireCursor(start);
  requireCursor(end);
  if (typeof key !== "string" || key.length === 0) throw new Error("Text mark key must be a nonempty string");
  if (value === undefined) throw new Error("Text mark value must be JSON or null");
  const ownCursor = (cursor: Cursor): Cursor => Object.freeze({
    anchor: cursor.anchor === null ? null : ownId(cursor.anchor), bind: cursor.bind,
  });
  return Object.freeze({ start: ownCursor(start), end: ownCursor(end), key, value });
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
  /** Formatting marks in application order. */
  readonly marks: readonly TextMark[];
  private knownAttributeCache: TextAttributes[] | undefined;

  private constructor(
    idList: IdList,
    valuesById: HamtMap<string>,
    marks: readonly TextMark[]
  ) {
    this.idList = idList;
    this.valuesById = valuesById;
    this.marks = marks;
  }

  static empty(): TextState {
    return new TextState(IdList.new(), HamtMap.empty<string>(), NO_MARKS);
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
    let marks: readonly TextMark[] = NO_MARKS;
    if (Object.hasOwn(data, "marks")) {
      if (!Array.isArray(data.marks)) throw new Error("Text snapshot marks must be an array");
      for (const mark of data.marks as readonly unknown[]) marks = addMark(idList, marks, ownMark(mark));
    }
    return new TextState(idList, valuesById, marks);
  }

  get length(): number {
    return this.idList.length;
  }

  idAt(index: number): ElementId {
    return this.idList.at(index);
  }

  /** Whether the element is visible, as opposed to unknown or deleted. */
  has(id: Readonly<ElementId>): boolean {
    return this.idList.has(id);
  }

  /** Whether the element is known, visible or as a tombstone. */
  knows(id: Readonly<ElementId>): boolean {
    return this.idList.isKnown(id);
  }

  /** The index of a visible element. */
  indexOf(id: Readonly<ElementId>): number {
    return this.idList.indexOf(id);
  }

  /** The index of a known element among all known elements, tombstones included. */
  knownIndexOf(id: Readonly<ElementId>): number {
    return this.idList.knownIds.indexOf(id);
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
    return new TextState(nextIdList, nextValues, this.marks);
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
    return new TextState(nextIdList, nextValues, this.marks);
  }

  /** Applies a mark; unknown anchors are a conflict, and the start must come before the end. */
  mark(operation: TextMarkOperation): TextState {
    return new TextState(this.idList, this.valuesById, addMark(this.idList, this.marks, operation));
  }

  private attributesByKnownIndex(): TextAttributes[] {
    return this.knownAttributeCache ??= knownAttributes(this.idList, this.marks);
  }

  /** The attributes of a visible element. */
  attributesAt(index: number): TextAttributes {
    if (this.marks.length === 0) return NO_ATTRIBUTES;
    const known = this.idList.knownIds.indexOf(this.idList.at(index));
    return this.knownAttributeCache?.[known] ?? attributesAtKnown(this.idList, this.marks, known);
  }

  /** The attributes of a known element, visible or deleted. */
  attributesOf(id: Readonly<ElementId>): TextAttributes {
    if (this.marks.length === 0) return NO_ATTRIBUTES;
    return this.attributesByKnownIndex()[this.idList.knownIds.indexOf(id)]!;
  }

  /** Visits every visible element in order with its attributes. */
  private *formatted(): IterableIterator<{ id: ElementId; attributes: TextAttributes }> {
    const attributes = this.marks.length === 0 ? undefined : this.attributesByKnownIndex();
    let known = 0;
    for (const { bunchId, startCounter, count, isDeleted } of this.idList.save()) {
      if (!isDeleted) {
        for (let offset = 0; offset < count; offset++) {
          yield { id: { bunchId, counter: startCounter + offset }, attributes: attributes?.[known + offset] ?? NO_ATTRIBUTES };
        }
      }
      known += count;
    }
  }

  /** The visible text as runs of equal attributes. */
  toDelta(): readonly { readonly insert: string; readonly attributes?: TextAttributes }[] {
    const runs: { insert: string; attributes: TextAttributes }[] = [];
    for (const { id, attributes } of this.formatted()) {
      const last = runs.at(-1);
      if (last !== undefined && (last.attributes === attributes || jsonEquals(last.attributes, attributes))) {
        last.insert += this.valueFor(id);
      } else runs.push({ insert: this.valueFor(id), attributes });
    }
    return Object.freeze(runs.map(({ insert, attributes }) =>
      Object.freeze(attributes === NO_ATTRIBUTES ? { insert } : { insert, attributes })));
  }

  /** The visible elements between two gaps, in order. */
  visibleIdsBetween(start: Cursor, end: Cursor): ElementId[] {
    const from = gapRank(this.idList, start), to = gapRank(this.idList, end), ids: ElementId[] = [];
    let known = 0;
    for (const { bunchId, startCounter, count, isDeleted } of this.idList.save()) {
      for (let offset = 0; offset < count; offset++, known++) {
        if (!isDeleted && from < 4 * known && 4 * known < to) ids.push({ bunchId, counter: startCounter + offset });
      }
    }
    return ids;
  }

  /** Whether `other` has the same elements and values, so only marks can differ. */
  private sameContent(other: TextState): boolean {
    return this.idList === other.idList && this.valuesById === other.valuesById;
  }

  /**
   * For the same content, the visible elements whose attributes differ, with `other`'s attributes.
   * Only elements inside the ranges of marks one side lacks are compared.
   */
  private *markChanges(other: TextState): IterableIterator<{ index: number; attributes: TextAttributes }> {
    if (sameMarks(this.marks, other.marks)) return;
    const intervals = changedIntervals(this.idList, this.marks, other.marks);
    const before = this.attributesByKnownIndex(), after = other.attributesByKnownIndex();
    let known = 0, visible = 0, next = 0;
    for (const { count, isDeleted } of this.idList.save()) {
      for (let offset = 0; offset < count; offset++, known++) {
        const position = 4 * known;
        while (next < intervals.length && intervals[next]![1] < position) next++;
        const interval = intervals[next];
        if (!isDeleted && interval !== undefined && interval[0] < position) {
          const was = before[known]!, is = after[known]!;
          if (was !== is && !jsonEquals(was, is)) yield { index: visible, attributes: is };
        }
        if (!isDeleted) visible++;
      }
    }
  }

  /** Runs in `other` whose attributes differ from here, and every run inserted since. */
  private formatsTo(other: TextState, targets?: Iterable<Readonly<ElementId>>): TextFormatChange[] {
    if (this.marks.length === 0 && other.marks.length === 0) return [];
    const formats: TextFormatChange[] = [];
    const add = (index: number, attributes: TextAttributes) => {
      const last = formats.at(-1);
      if (last !== undefined && last.index + last.count === index && jsonEquals(last.attributes, attributes)) {
        formats[formats.length - 1] = { ...last, count: last.count + 1 };
      } else {
        formats.push({ index, count: 1, attributes });
      }
    };
    if (this.sameContent(other)) {
      for (const { index, attributes } of this.markChanges(other)) add(index, attributes);
    } else if (targets !== undefined && sameMarks(this.marks, other.marks)) {
      // Equal marks give every element seen on both sides the same attributes: report insertions only.
      const inserted: number[] = [];
      for (const id of targets) if (other.idList.has(id) && !this.idList.has(id)) inserted.push(other.idList.indexOf(id));
      for (const index of inserted.sort((a, b) => a - b)) add(index, other.attributesAt(index));
    } else {
      const before = new Map<string, TextAttributes>();
      for (const { id, attributes } of this.formatted()) before.set(idKey(id), attributes);
      let index = 0;
      for (const { id, attributes } of other.formatted()) {
        const previous = before.get(idKey(id));
        if (previous === undefined || !jsonEquals(previous, attributes)) add(index, attributes);
        index++;
      }
    }
    return formats.map((format) => Object.freeze(format));
  }

  *values(): IterableIterator<string> {
    for (const id of this.idList) yield this.valueFor(id);
  }

  toString(): string {
    return [...this.values()].join("");
  }

  /** Removing all targets must leave the same ordered elements on both sides. */
  changesTo(other: TextState, targetIds?: Iterable<Readonly<ElementId>>): TextChangeEvent {
    const changes: TextChange[] = [];
    // Read twice: once for content, once for formats.
    const targets = targetIds === undefined ? undefined : [...targetIds];
    const result = (): TextChangeEvent => {
      const formats = this === other ? [] : this.formatsTo(other, targets);
      return Object.freeze({ beforeLength: this.length, afterLength: other.length,
        changes: Object.freeze(changes.reverse()), ...(formats.length === 0 ? {} : { formats: Object.freeze(formats) }) });
    };
    if (this === other || this.sameContent(other)) return result();

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
    // Equal marks give elements seen on both sides equal attributes; a mark can change any of them.
    if (!sameMarks(this.marks, other.marks) || operations.some((operation) => operation.type === "text/mark")) {
      return this.visibleEquals(other);
    }

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
      } else if (operation.type === "text/delete") {
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
    if (this.sameContent(other)) return this.markChanges(other).next().done === true;

    const left = this.idList.values();
    const right = other.idList.values();
    while (true) {
      const leftNext = left.next();
      const rightNext = right.next();
      if (leftNext.done || rightNext.done) {
        if (leftNext.done !== rightNext.done) return false;
        break;
      }
      if (!equalsId(leftNext.value, rightNext.value)) return false;
      if (this.valueFor(leftNext.value) !== other.valueFor(rightNext.value)) {
        return false;
      }
    }
    if (sameMarks(this.marks, other.marks)) return true;
    const otherFormatted = other.formatted();
    for (const { attributes } of this.formatted()) {
      const next = otherFormatted.next();
      if (next.done === true || !jsonEquals(attributes, next.value.attributes)) return false;
    }
    return true;
  }

  save(): TextSnapshotData {
    const idList = Object.freeze(
      this.idList.save().map((range) => Object.freeze({ ...range }))
    );
    const values: string[] = [], boundaries: number[] = [];
    let offset = 0, previous = NaN;
    // The saved ranges already give the visible IDs in order.
    for (const { bunchId, startCounter, count, isDeleted } of idList) {
      if (isDeleted) continue;
      for (let index = 0; index < count; index++) {
        const element = this.valueFor({ bunchId, counter: startCounter + index });
        if (isHighSurrogate(previous) && isLowSurrogate(element.charCodeAt(0))) boundaries.push(offset);
        values.push(element);
        offset += element.length;
        previous = element.charCodeAt(element.length - 1);
      }
    }
    return Object.freeze({ idList, value: values.join(""),
      ...(boundaries.length === 0 ? {} : { surrogateBoundaries: Object.freeze(boundaries) }),
      ...(this.marks.length === 0 ? {} : { marks: Object.freeze(this.marks.map(ownMark)) }),
    });
  }

  /** The value of a visible element. */
  valueFor(id: Readonly<ElementId>): string {
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
  operation: TextMarkOperation<Path>
): TextMarkOperation<Path>;
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
  if (operation.type === "text/mark") {
    const { start, end, key, value } = ownMark(operation);
    return Object.freeze({ type: operation.type, path: operation.path, start, end, key, value });
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
  } else if (operation.type === "text/delete") {
    for (const range of operation.ranges) yield* idsInRange(range.start, range.count);
  }
}

/** Internal mutable API wrapper around a persistent TextState. */
export class RuntimeText implements Text<MarkShape> {
  private current: TextState;
  private readonly markConfigs: MarkShape;
  private readonly path: string;
  private readonly mutate: (operation: TextOperation) => void;
  private readonly idGenerator: ElementIdGenerator;
  private readonly beforeMutation: () => void;
  private bunchSeq: number;
  private readonly observers: CollectionObservers<TextState, TextChangeEvent, Readonly<ElementId>>;

  constructor(
    mutate: (operation: TextOperation) => void,
    clientId: string,
    path: string,
    initialState: TextState,
    beforeMutation: () => void,
    lastBunchSeq: number,
    beforeObserve: () => () => void,
    marks: MarkShape = {}
  ) {
    this.mutate = mutate;
    this.path = path;
    this.current = initialState;
    this.markConfigs = marks;

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

  get state(): TextState {
    return this.current;
  }

  get length(): number {
    return this.current.length;
  }

  insert(index: number, value: string): void {
    requireNumber(index, "Index");
    if (!Number.isSafeInteger(index) || index < 0 || index > this.length) {
      throw new RangeError(`Index out of bounds: ${index} (length: ${this.length})`);
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
    requireNumber(index, "Index");
    requireNumber(count, "Delete count");
    if (!Number.isSafeInteger(index) || index < 0 || index > this.length) {
      throw new RangeError(`Index out of bounds: ${index} (length: ${this.length})`);
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError(`Invalid delete count: ${count}`);
    }
    if (count > this.length - index) {
      throw new RangeError(
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

  format(index: number, count: number, key: string, value: JsonValue | null): void {
    requireNumber(index, "Index");
    requireNumber(count, "Count");
    if (!Number.isSafeInteger(index) || index < 0 || index > this.length) {
      throw new RangeError(`Index out of bounds: ${index} (length: ${this.length})`);
    }
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`Invalid format count: ${count}`);
    if (count > this.length - index) {
      throw new RangeError(`Format range out of bounds: ${index} + ${count} (length: ${this.length})`);
    }
    if (typeof key !== "string") throw new TypeError("Mark key must be a string");
    const config = Object.hasOwn(this.markConfigs, key) ? this.markConfigs[key] : undefined;
    if (config === undefined) throw new Error(`Unknown mark for ${this.path}: ${key}`);
    if (value !== null) {
      validateJsonValue(value, [this.path, key]);
      checkPayload(config.payload, value, [this.path, key]);
    }
    if (count === 0) return;

    this.beforeMutation();
    const { expand } = config;
    const operation = freezeTextOperation({
      type: "text/mark",
      path: this.path,
      start: this.current.cursorAt(index, expand === "before" || expand === "both" ? "left" : "right"),
      end: this.current.cursorAt(index + count, expand === "after" || expand === "both" ? "right" : "left"),
      key,
      value,
    });
    this.current = this.current.mark(operation);
    this.mutate(operation);
  }

  attributesAt(index: number): TextAttributes {
    requireNumber(index, "Index");
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Index out of bounds: ${index} (length: ${this.length})`);
    }
    return this.current.attributesAt(index);
  }

  toDelta(): readonly TextDeltaOp[] {
    return this.current.toDelta();
  }

  /** ID-targeted writes for the undo manager; each records one operation like the index-based API. */
  [historyWriter]() {
    return {
      /** Inserts `value` right after the `before` element, which may be a tombstone; returns the first new ID. */
      insertAfter: (before: Readonly<ElementId> | null, value: string): Readonly<ElementId> => {
        this.beforeMutation();
        const operation = freezeTextOperation({ type: "text/insert", path: this.path, before,
          // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
          id: this.idGenerator.generateAfter(before, [...value].length), value });
        this.current = this.current.insert(operation);
        this.mutate(operation);
        return operation.id;
      },
      delete: (ids: readonly Readonly<ElementId>[]): void => {
        this.beforeMutation();
        const operation = freezeTextOperation({ type: "text/delete", path: this.path, ranges: compressIds(ids) });
        this.current = this.current.delete(operation);
        this.mutate(operation);
      },
      /** Sets `key` on exactly the visible elements from `first` to `last`, without expanding. */
      format: (first: Readonly<ElementId>, last: Readonly<ElementId>, key: string, value: JsonValue | null): void => {
        this.beforeMutation();
        const operation = freezeTextOperation({ type: "text/mark", path: this.path,
          start: { anchor: first, bind: "right" }, end: { anchor: last, bind: "left" }, key, value });
        this.current = this.current.mark(operation);
        this.mutate(operation);
      },
    };
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
