import type { ElementId, IdList } from "articulated";
import type { Cursor } from "./cursor.ts";
import { CollectionConflictError } from "./conflict.ts";
import { jsonEquals } from "./json.ts";
import type { JsonValue } from "./schema.ts";

/** One formatting mark: `key` set to `value` (or removed, for `null`) between two gaps. */
export interface TextMark {
  readonly start: Cursor;
  readonly end: Cursor;
  readonly key: string;
  readonly value: JsonValue | null;
}

/** The marks one Text element has, by key; removed marks are absent. */
export type TextAttributes = Readonly<Record<string, JsonValue>>;

export const NO_ATTRIBUTES: TextAttributes = Object.freeze({});

function idKey(id: Readonly<ElementId>): string {
  return JSON.stringify([id.bunchId, id.counter]);
}

/**
 * Orders gaps by known position, tombstones included: known element k sits at 4k, the gap right
 * after it at 4k + 1 and the gap right before it at 4k - 1. Known order never changes, and new
 * elements land strictly between two existing gaps, so these comparisons hold forever.
 */
export function gapRank(idList: IdList, cursor: Cursor): number {
  if (cursor.anchor === null) return cursor.bind === "left" ? -Infinity : Infinity;
  if (!idList.isKnown(cursor.anchor)) {
    throw new CollectionConflictError(`Unknown text mark anchor: ${idKey(cursor.anchor)}`);
  }
  const position = 4 * idList.knownIds.indexOf(cursor.anchor);
  return cursor.bind === "left" ? position + 1 : position - 1;
}

/**
 * Appends `mark`, dropping earlier marks of its key whose range lies inside it: the new mark
 * decides every element they cover, now and after any later insertion.
 */
export function addMark(idList: IdList, marks: readonly TextMark[], mark: TextMark): readonly TextMark[] {
  const start = gapRank(idList, mark.start), end = gapRank(idList, mark.end);
  if (start >= end) throw new Error("Text mark start must come before its end");
  const kept = marks.filter((earlier) => earlier.key !== mark.key ||
    gapRank(idList, earlier.start) < start || gapRank(idList, earlier.end) > end);
  kept.push(mark);
  return Object.freeze(kept);
}

/** Whether two mark lists are the same marks in the same order. */
export function sameMarks(left: readonly TextMark[], right: readonly TextMark[]): boolean {
  return left === right || (left.length === right.length && left.every((mark, index) => mark === right[index]));
}

function freezeAttributes(values: Map<string, JsonValue>): TextAttributes {
  if (values.size === 0) return NO_ATTRIBUTES;
  return Object.freeze(Object.fromEntries([...values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** The attributes of the known element at `knownIndex`: per key, the last mark covering it. */
export function attributesAtKnown(idList: IdList, marks: readonly TextMark[], knownIndex: number): TextAttributes {
  const position = 4 * knownIndex, decided = new Set<string>(), values = new Map<string, JsonValue>();
  for (let index = marks.length - 1; index >= 0; index--) {
    const mark = marks[index]!;
    if (decided.has(mark.key)) continue;
    if (gapRank(idList, mark.start) < position && position < gapRank(idList, mark.end)) {
      decided.add(mark.key);
      if (mark.value !== null) values.set(mark.key, mark.value);
    }
  }
  return freezeAttributes(values);
}

/** The attributes of every known element, tombstones included, in known order. Equal runs share one object. */
export function knownAttributes(idList: IdList, marks: readonly TextMark[]): TextAttributes[] {
  const count = idList.knownIds.length;
  const result = new Array<TextAttributes>(count);
  if (marks.length === 0) return result.fill(NO_ATTRIBUTES);
  const ranked = marks.map((mark, order) => ({
    mark, order, start: gapRank(idList, mark.start), end: gapRank(idList, mark.end),
  }));
  const opens = [...ranked].sort((a, b) => a.start - b.start);
  const closes = [...ranked].sort((a, b) => a.end - b.end);
  const active = new Map<string, Set<(typeof ranked)[number]>>();
  let opened = 0, closed = 0, dirty = false, current = NO_ATTRIBUTES;
  for (let known = 0; known < count; known++) {
    const position = 4 * known;
    // Opens first: a mark that both starts and ends before this element was active for earlier ones.
    while (opened < opens.length && opens[opened]!.start < position) {
      const entry = opens[opened++]!;
      let set = active.get(entry.mark.key);
      if (set === undefined) active.set(entry.mark.key, set = new Set());
      set.add(entry);
      dirty = true;
    }
    while (closed < closes.length && closes[closed]!.end < position) {
      const entry = closes[closed++]!;
      active.get(entry.mark.key)?.delete(entry);
      dirty = true;
    }
    if (dirty) {
      const values = new Map<string, JsonValue>();
      for (const [key, set] of active) {
        let last: (typeof ranked)[number] | undefined;
        for (const entry of set) if (last === undefined || entry.order > last.order) last = entry;
        if (last !== undefined && last.mark.value !== null) values.set(key, last.mark.value);
      }
      const next = freezeAttributes(values);
      if (!jsonEquals(next, current)) current = next;
      dirty = false;
    }
    result[known] = current;
  }
  return result;
}

/**
 * Rank intervals, merged and sorted, outside which two mark lists on one IdList give every element
 * the same attributes: the ranges of the marks only one of them has.
 */
export function changedIntervals(idList: IdList, left: readonly TextMark[], right: readonly TextMark[]): [number, number][] {
  const inLeft = new Set(left), inRight = new Set(right);
  const intervals = [...left.filter((mark) => !inRight.has(mark)), ...right.filter((mark) => !inLeft.has(mark))]
    .map((mark): [number, number] => [gapRank(idList, mark.start), gapRank(idList, mark.end)])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last !== undefined && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push(interval);
  }
  return merged;
}
