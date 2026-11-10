// @ts-check
// Shared by the page, the server and the tests: no DOM and no network.
import { defineDocument, list } from "../../dist/index.js";

/** A card's `id` is application data: it stays the same when the card moves, unlike its List element ID.
 * @typedef {{ id: string, title: string }} Card */
/** @typedef {import("../../dist/index.js").ListSchema<Card>} CardList */

export const COLUMNS = /** @type {const} */ (["todo", "doing", "done"]);
/** @typedef {(typeof COLUMNS)[number]} Column */

export const Board = defineDocument({
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- Pins the element type for tsc --checkJs.
  todo: /** @type {CardList} */ (list()),
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- As above.
  doing: /** @type {CardList} */ (list()),
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- As above.
  done: /** @type {CardList} */ (list()),
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

/** Where a card is now, by its application ID. O(cards).
 * @param {BoardDocument} doc @param {string} cardId
 * @returns {{column: Column, index: number, card: Card} | undefined} */
export function findCard(doc, cardId) {
  for (const column of COLUMNS) {
    let index = 0;
    for (const card of doc.state[column]) {
      if (card.id === cardId) return { column, index, card };
      index++;
    }
  }
  return undefined;
}

/** @param {BoardDocument} doc @param {Column} column @param {string} title @param {string} [id] */
export function addCard(doc, column, title, id = crypto.randomUUID()) {
  const card = { id, title: normalizeTitle(title) };
  doc.state[column].push(card);
  return card;
}

/** Replaces the title with List `set()`, which keeps the element's ID. Returns false if the card is gone.
 * @param {BoardDocument} doc @param {string} cardId @param {string} title */
export function renameCard(doc, cardId, title) {
  const next = normalizeTitle(title);
  const found = findCard(doc, cardId);
  if (found === undefined) return false;
  if (found.card.title !== next) doc.state[found.column].set(found.index, { ...found.card, title: next });
  return true;
}

/** @param {BoardDocument} doc @param {string} cardId */
export function deleteCard(doc, cardId) {
  const found = findCard(doc, cardId);
  if (found === undefined) return false;
  doc.state[found.column].delete(found.index);
  return true;
}

/**
 * Moves a card to gap `toIndex` of `toColumn`, counted in the view before the move. There is no List
 * move: one batch deletes the element and inserts the same card, which gets a new element ID. The
 * server policy relies on a move batch being exactly that delete followed by that insert.
 * Returns false if the card is gone or would not move.
 * @param {BoardDocument} doc @param {string} cardId @param {Column} toColumn @param {number} toIndex
 */
export function moveCard(doc, cardId, toColumn, toIndex) {
  const found = findCard(doc, cardId);
  if (found === undefined) return false;
  const target = doc.state[toColumn];
  if (!Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex > target.length) {
    throw new RangeError(`Gap ${toIndex} is outside ${toColumn}`);
  }
  const sameColumn = found.column === toColumn;
  if (sameColumn && (toIndex === found.index || toIndex === found.index + 1)) return false;
  const insertAt = sameColumn && toIndex > found.index ? toIndex - 1 : toIndex;
  doc.transact(() => {
    doc.state[found.column].delete(found.index);
    target.insert(insertAt, found.card);
  });
  return true;
}

/**
 * The writer's selected card. It follows the card by ID, including after a move; once the card
 * is deleted, a cursor bound to its old position selects the card that took its place.
 * @param {BoardDocument} doc
 */
export function createSelection(doc) {
  /** @type {{cardId: string, column: Column, cursor: import("../../dist/index.js").Cursor} | undefined} */
  let selected;
  /** @param {Column} column @param {number} index */
  function remember(column, index) {
    const cards = doc.state[column];
    const card = cards.get(index);
    selected = { cardId: card.id, column, cursor: cards.cursorAt(index, "right") };
    return { column, index, card };
  }
  return {
    get cardId() { return selected?.cardId; },
    /** @param {string} cardId */
    select(cardId) {
      const found = findCard(doc, cardId);
      if (found === undefined) return undefined;
      return remember(found.column, found.index);
    },
    clear() { selected = undefined; },
    /** Re-reads the selection after any change. */
    resolve() {
      if (selected === undefined) return undefined;
      const found = findCard(doc, selected.cardId);
      if (found !== undefined) return remember(found.column, found.index);
      const cards = doc.state[selected.column];
      const gap = cards.cursorIndex(selected.cursor);
      if (gap === undefined || cards.length === 0) { selected = undefined; return undefined; }
      return remember(selected.column, Math.min(gap, cards.length - 1));
    },
  };
}
