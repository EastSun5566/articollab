// @ts-check

/** @template T @typedef {{insert(index: number, value: T): void, remove(index: number): void, update(index: number, value: T): void}} ColumnRenderer */

/**
 * Renders a List once, then applies each `observe()` change instead of re-reading the whole List.
 * Changes arrive by descending index with a set before a splice at the same index, so applying them
 * in order keeps every index valid. A set keeps the row; a move arrives as a removal and an insertion.
 * @template {import("../../dist/index.js").JsonValue} T
 * @param {import("../../dist/index.js").List<T>} list
 * @param {ColumnRenderer<T>} render
 * @returns {() => void} Stops observing.
 */
export function observeColumn(list, render) {
  let index = 0;
  for (const value of list) render.insert(index++, value);
  return list.observe(({ changes }) => {
    for (const change of changes) {
      if (change.type === "set") { render.update(change.index, change.value); continue; }
      for (let count = 0; count < change.deleteCount; count++) render.remove(change.index);
      change.insert.forEach((value, offset) => { render.insert(change.index + offset, value); });
    }
  });
}
