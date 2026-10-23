// @ts-check

/** @param {readonly string[]} elements */
function offsets(elements) {
  const result = [0];
  let total = 0;
  for (const element of elements) { total += element.length; result.push(total); }
  return result;
}

/** @param {readonly number[]} positions @param {number} index */
function at(positions, index) {
  const result = positions[index];
  if (result === undefined) throw new Error("Position is outside the Text mirror");
  return result;
}

/** Translate old-document UTF-16 ranges without reparsing untouched Text elements.
 * @param {readonly string[]} elements
 * @param {import("@codemirror/state").Transaction} transaction
 */
export function editorEdits(elements, transaction) {
  const positions = offsets(elements);
  if (positions[positions.length - 1] !== transaction.startState.doc.length) {
    throw new Error("Editor and Text mirror lengths differ");
  }
  /** @type {{start: number, end: number}[]} */
  const regions = [];
  transaction.changes.iterChanges((from, to) => {
    let start = 0;
    while (start + 1 < positions.length && at(positions, start + 1) <= from) start++;
    let end = start;
    while (at(positions, end) < to) end++;
    // An insertion inside a surrogate pair must replace that entire element.
    if (at(positions, start) < from && end === start) end++;
    const previous = regions[regions.length - 1];
    if (previous !== undefined && start <= previous.end) previous.end = Math.max(previous.end, end);
    else regions.push({ start, end });
  });
  return regions.flatMap(({ start, end }) => {
    const from = transaction.changes.mapPos(at(positions, start), -1);
    const to = transaction.changes.mapPos(at(positions, end), 1);
    const insert = transaction.newDoc.sliceString(from, to, "\n");
    return elements.slice(start, end).join("") === insert ? [] : [{
      index: start, deleteCount: end - start, insert,
    }];
  }).toReversed();
}

/** Each event uses one pre-event coordinate space, in descending element order.
 * @param {readonly string[]} elements
 * @param {import("../../dist/index.js").TextChangeEvent} event
 */
export function textEdits(elements, event) {
  if (elements.length !== event.beforeLength) throw new Error("Text observer baseline differs");
  const positions = offsets(elements);
  const changes = event.changes.map(({ index, deleteCount, insert }) => ({
    from: at(positions, index), to: at(positions, index + deleteCount), insert: insert.join(""),
  })).toReversed();
  let next = elements.slice();
  for (const { index, deleteCount, insert } of event.changes) {
    next = next.slice(0, index).concat(insert, next.slice(index + deleteCount));
  }
  if (next.length !== event.afterLength) throw new Error("Text observer result length differs");
  return { changes, elements: next };
}
