// @ts-check
// Shared by the page, the server and the tests: no DOM and no network.
import { defineDocument, list, map } from "../../dist/index.js";

/** A card as the page shows it: its ID, which never changes, and its title. @typedef {{ id: string, title: string }} Card */

export const COLUMNS = /** @type {const} */ (["todo", "doing", "done"]);
/** @typedef {(typeof COLUMNS)[number]} Column */

/**
 * One List orders every card, a Map records each card's column and another its title. Each column
 * shows the cards of that column in `order`. Moving a card is a List move plus, between columns, a
 * column change; renaming touches only `titles`. Each part is decided by server order on its own,
 * so concurrent moves, column changes and renames never conflict or duplicate a card.
 */
export const Board = defineDocument({
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- Pins the element type for tsc --checkJs.
  order: /** @type {import("../../dist/index.js").ListSchema<string>} */ (list()),
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- As above.
  columns: /** @type {import("../../dist/index.js").MapSchema<Column>} */ (map()),
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- As above.
  titles: /** @type {import("../../dist/index.js").MapSchema<string>} */ (map()),
});
/** @typedef {typeof Board.definition} Shape */
/** @typedef {import("../../dist/index.js").ClientDocument<Shape>} BoardDocument */

export const MAX_TITLE_LENGTH = 200;

/** @param {string} title */
export function normalizeTitle(title) {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) {
    throw new RangeError(`A card title needs 1–${MAX_TITLE_LENGTH} characters`);
  }
  return trimmed;
}

/** The card shown for an ID; the title is empty if its data has not arrived.
 * @param {BoardDocument} doc @param {string} cardId @returns {Card} */
export function cardFor(doc, cardId) {
  return { id: cardId, title: doc.state.titles.get(cardId) ?? "" };
}

/** The card IDs a column shows, in board order. @param {BoardDocument} doc @param {Column} column */
export function cardsIn(doc, column) {
  return doc.state.order.toArray().filter((id) => doc.state.columns.get(id) === column);
}

/** Where a card is now: its column, its index there and its index in `order`. O(cards).
 * @param {BoardDocument} doc @param {string} cardId
 * @returns {{column: Column, index: number, position: number, card: Card} | undefined} */
export function findCard(doc, cardId) {
  const column = doc.state.columns.get(cardId);
  if (column === undefined) return undefined;
  let index = 0, position = 0;
  for (const id of doc.state.order) {
    if (id === cardId) return { column, index, position, card: cardFor(doc, cardId) };
    if (doc.state.columns.get(id) === column) index++;
    position++;
  }
  return undefined;
}

/** Writes the card's position, column and title in one batch.
 * @param {BoardDocument} doc @param {Column} column @param {string} title @param {string} [id] */
export function addCard(doc, column, title, id = crypto.randomUUID()) {
  const card = { id, title: normalizeTitle(title) };
  doc.transact(() => {
    doc.state.titles.set(id, card.title);
    doc.state.columns.set(id, column);
    doc.state.order.push(id);
  });
  return card;
}

/** Writes only `titles`, so a concurrent move cannot affect it. Returns false if the card is gone.
 * @param {BoardDocument} doc @param {string} cardId @param {string} title */
export function renameCard(doc, cardId, title) {
  const next = normalizeTitle(title);
  if (findCard(doc, cardId) === undefined) return false;
  if (doc.state.titles.get(cardId) !== next) doc.state.titles.set(cardId, next);
  return true;
}

/** Removes the card's position, column and title in one batch.
 * @param {BoardDocument} doc @param {string} cardId */
export function deleteCard(doc, cardId) {
  const found = findCard(doc, cardId);
  if (found === undefined) return false;
  doc.transact(() => {
    doc.state.order.delete(found.position);
    doc.state.columns.delete(cardId);
    doc.state.titles.delete(cardId);
  });
  return true;
}

/**
 * Moves a card to gap `toIndex` of `toColumn`, counted in that column's view before the move. The
 * card keeps its List element: one List move places it before the card now at that gap (or after
 * the column's last card), and a column change follows if it changes column.
 * Returns false if the card is gone or would not move.
 * @param {BoardDocument} doc @param {string} cardId @param {Column} toColumn @param {number} toIndex
 */
export function moveCard(doc, cardId, toColumn, toIndex) {
  const found = findCard(doc, cardId);
  if (found === undefined) return false;
  const target = cardsIn(doc, toColumn);
  if (!Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex > target.length) {
    throw new RangeError(`Gap ${toIndex} is outside ${toColumn}`);
  }
  const sameColumn = found.column === toColumn;
  if (sameColumn && (toIndex === found.index || toIndex === found.index + 1)) return false;
  // Positions in `order` once the card is taken out of it.
  const rest = doc.state.order.toArray().filter((id) => id !== cardId);
  const remaining = target.filter((id) => id !== cardId);
  const slot = sameColumn && toIndex > found.index ? toIndex - 1 : toIndex;
  const anchor = remaining[slot], last = remaining.at(-1);
  // Before the card now at the gap, else after the column's last card, else at the end.
  const to = anchor !== undefined ? rest.indexOf(anchor) : last !== undefined ? rest.indexOf(last) + 1 : rest.length;
  doc.transact(() => {
    if (to !== found.position) doc.state.order.move(found.position, to);
    if (!sameColumn) doc.state.columns.set(cardId, toColumn);
  });
  return true;
}

/**
 * Renames this writer will lose: a peer's commit deleted these cards while this writer's renames of
 * them are still pending, so the server will apply each rename after the delete and the policy will
 * drop it. Call it with each received peer commit and the writer's pending batches.
 * @param {import("../../dist/index.js").ServerCommit<import("../../dist/index.js").DocumentOperation<Shape>>} commit
 * @param {readonly import("../../dist/index.js").ClientBatch<import("../../dist/index.js").DocumentOperation<Shape>>[]} pendingBatches
 * @returns {Card[]} The last pending title per lost card, in commit order.
 */
export function lostRenames(commit, pendingBatches) {
  /** @type {Map<string, string>} */
  const titles = new Map();
  for (const batch of pendingBatches) {
    for (const operation of batch.operations) {
      if (operation.type === "map/set" && operation.path === "titles") titles.set(operation.key, operation.value);
    }
  }
  /** @type {Card[]} */
  const lost = [];
  for (const operation of commit.operations) {
    if (operation.type !== "map/delete" || operation.path !== "titles") continue;
    const title = titles.get(operation.key);
    if (title !== undefined) lost.push({ id: operation.key, title });
  }
  return lost;
}

/**
 * The writer's selected card. It follows the card by ID, including after a move; once the card is
 * deleted, a cursor bound to its old place in `order` selects the nearest card of the same column.
 * @param {BoardDocument} doc
 */
export function createSelection(doc) {
  /** @type {{cardId: string, column: Column, cursor: import("../../dist/index.js").Cursor} | undefined} */
  let selected;
  /** @param {string} cardId */
  function remember(cardId) {
    const found = findCard(doc, cardId);
    if (found === undefined) return undefined;
    selected = { cardId, column: found.column, cursor: doc.state.order.cursorAt(found.position, "right") };
    return { column: found.column, index: found.index, card: found.card };
  }
  return {
    get cardId() { return selected?.cardId; },
    /** @param {string} cardId */
    select(cardId) { return remember(cardId); },
    clear() { selected = undefined; },
    /** Re-reads the selection after any change. */
    resolve() {
      if (selected === undefined) return undefined;
      const current = remember(selected.cardId);
      if (current !== undefined) return current;
      const order = doc.state.order.toArray();
      const gap = doc.state.order.cursorIndex(selected.cursor);
      const column = selected.column;
      selected = undefined;
      if (gap === undefined) return undefined;
      // The next card of the same column, otherwise the previous one.
      const after = order.slice(gap).find((id) => doc.state.columns.get(id) === column);
      const before = order.slice(0, gap).findLast((id) => doc.state.columns.get(id) === column);
      const next = after ?? before;
      return next === undefined ? undefined : remember(next);
    },
  };
}
