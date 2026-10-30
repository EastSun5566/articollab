// @ts-check

/**
 * Text indices count elements, while CodeMirror offsets count UTF-16 units. Only elements
 * two units long (supplementary code points) make them differ; separately inserted surrogate
 * halves are one unit each. Keeping just their sorted indices makes BMP documents O(1) to map,
 * and others O(log w) to map and O(w) to update, where w is the number of wide elements.
 * @typedef {{ readonly length: number, readonly wide: readonly number[] }} TextMirror
 */

/** @param {Iterable<string>} elements @returns {TextMirror} */
export function createMirror(elements) {
  /** @type {number[]} */
  const wide = [];
  let length = 0;
  for (const element of elements) {
    if (element.length === 2) wide.push(length);
    length++;
  }
  return { length, wide };
}

/** Number of entries in sorted `values` that are less than `limit`.
 * @param {readonly number[]} values @param {number} limit
 */
function countBelow(values, limit) {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const value = values[middle];
    if (value !== undefined && value < limit) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** @param {TextMirror} mirror @param {number} index */
function offsetOf(mirror, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > mirror.length) {
    throw new Error("Position is outside the Text mirror");
  }
  return mirror.wide.length === 0 ? index : index + countBelow(mirror.wide, index);
}

/** Element boundary at or before a UTF-16 offset, and whether the offset splits a wide element.
 * @param {TextMirror} mirror @param {number} offset
 */
function elementAt(mirror, offset) {
  const { wide } = mirror;
  // Wide element k ends at wide[k] + k + 2, which increases strictly with k.
  let low = 0, high = wide.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const start = wide[middle];
    if (start !== undefined && start + middle + 2 <= offset) low = middle + 1;
    else high = middle;
  }
  const next = wide[low];
  if (next !== undefined && next + low + 1 === offset) return { index: next, inside: true };
  const index = offset - low;
  if (index < 0 || index > mirror.length) throw new Error("Position is outside the Text mirror");
  return { index, inside: false };
}

/** Element gap at or before a UTF-16 offset; an offset inside a surrogate pair maps to the gap before it.
 * @param {TextMirror} mirror @param {number} offset
 */
export function elementIndexAt(mirror, offset) {
  return elementAt(mirror, offset).index;
}

/** UTF-16 offset of an element gap. @param {TextMirror} mirror @param {number} index */
export function editorOffset(mirror, index) {
  return offsetOf(mirror, index);
}

/** Rebuild elements from editor text for inspection; this is linear and not used per edit.
 * @param {TextMirror} mirror @param {string} text
 */
export function mirrorElements(mirror, text) {
  if (offsetOf(mirror, mirror.length) !== text.length) throw new Error("Editor and Text mirror lengths differ");
  /** @type {string[]} */
  const elements = [];
  let offset = 0, next = 0;
  for (let index = 0; index < mirror.length; index++) {
    const size = mirror.wide[next] === index ? (next++, 2) : 1;
    elements.push(text.slice(offset, offset + size));
    offset += size;
  }
  return elements;
}

/** Translate old-document UTF-16 ranges without reparsing untouched Text elements.
 * @param {TextMirror} mirror
 * @param {import("@codemirror/state").Transaction} transaction
 */
export function editorEdits(mirror, transaction) {
  if (offsetOf(mirror, mirror.length) !== transaction.startState.doc.length) {
    throw new Error("Editor and Text mirror lengths differ");
  }
  /** @type {{start: number, end: number}[]} */
  const regions = [];
  transaction.changes.iterChanges((from, to) => {
    // A change inside a surrogate pair must replace that entire element.
    const start = elementAt(mirror, from).index;
    const last = elementAt(mirror, to);
    const end = last.inside ? last.index + 1 : last.index;
    const previous = regions[regions.length - 1];
    if (previous !== undefined && start <= previous.end) previous.end = Math.max(previous.end, end);
    else regions.push({ start, end });
  });
  return regions.flatMap(({ start, end }) => {
    const oldFrom = offsetOf(mirror, start), oldTo = offsetOf(mirror, end);
    const from = transaction.changes.mapPos(oldFrom, -1);
    const to = transaction.changes.mapPos(oldTo, 1);
    const insert = transaction.newDoc.sliceString(from, to, "\n");
    return transaction.startState.doc.sliceString(oldFrom, oldTo, "\n") === insert ? [] : [{
      index: start, deleteCount: end - start, insert,
    }];
  }).toReversed();
}

/** Each event uses one pre-event coordinate space, in descending element order.
 * @param {TextMirror} mirror
 * @param {import("../../dist/index.js").TextChangeEvent} event
 */
export function textEdits(mirror, event) {
  if (mirror.length !== event.beforeLength) throw new Error("Text observer baseline differs");
  const changes = event.changes.map(({ index, deleteCount, insert }) => ({
    from: offsetOf(mirror, index), to: offsetOf(mirror, index + deleteCount), insert: insert.join(""),
  })).toReversed();
  const wide = mirror.wide.slice();
  let length = mirror.length;
  // Descending changes never move the indices of changes applied after them.
  for (const { index, deleteCount, insert } of event.changes) {
    const first = countBelow(wide, index), last = countBelow(wide, index + deleteCount);
    /** @type {number[]} */
    const inserted = [];
    insert.forEach((element, offset) => { if (element.length === 2) inserted.push(index + offset); });
    wide.splice(first, last - first, ...inserted);
    const shift = insert.length - deleteCount;
    if (shift !== 0) {
      for (let position = first + inserted.length; position < wide.length; position++) {
        const value = wide[position];
        if (value !== undefined) wide[position] = value + shift;
      }
    }
    length += shift;
  }
  if (length !== event.afterLength) throw new Error("Text observer result length differs");
  return { changes, mirror: { length, wide } };
}
