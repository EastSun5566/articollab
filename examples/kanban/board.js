// @ts-check
// Shared by the page, the server and the tests: no DOM and no network.
import { defineDocument, list, map } from "../../dist/index.js";

/** What the `cards` Map stores under a card ID. @typedef {{ title: string }} CardData */
/** A card as the page shows it: its ID, which never changes, and its data. @typedef {{ id: string, title: string }} Card */

export const COLUMNS = /** @type {const} */ (["todo", "doing", "done"]);
/** @typedef {(typeof COLUMNS)[number]} Column */

/**
 * Position and data are kept apart: each column is a List of card IDs, and the `cards` Map holds
 * each card's data under its ID. A move changes only the Lists and a rename only the Map, so the
 * two never conflict.
 */
export const Board = defineDocument({
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- Pins the element type for tsc --checkJs.
  todo: /** @type {import("../../dist/index.js").ListSchema<string>} */ (list()),
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- As above.
  doing: /** @type {import("../../dist/index.js").ListSchema<string>} */ (list()),
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- As above.
  done: /** @type {import("../../dist/index.js").ListSchema<string>} */ (list()),
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- As above.
  cards: /** @type {import("../../dist/index.js").MapSchema<CardData>} */ (map()),
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
  return { id: cardId, title: doc.state.cards.get(cardId)?.title ?? "" };
}

/** Where a card is now, by its ID. O(cards).
 * @param {BoardDocument} doc @param {string} cardId
 * @returns {{column: Column, index: number, card: Card} | undefined} */
export function findCard(doc, cardId) {
  for (const column of COLUMNS) {
    let index = 0;
    for (const id of doc.state[column]) {
      if (id === cardId) return { column, index, card: cardFor(doc, cardId) };
      index++;
    }
  }
  return undefined;
}

/** Writes the card's data and its position in one batch.
 * @param {BoardDocument} doc @param {Column} column @param {string} title @param {string} [id] */
export function addCard(doc, column, title, id = crypto.randomUUID()) {
  const card = { id, title: normalizeTitle(title) };
  doc.transact(() => {
    doc.state.cards.set(id, { title: card.title });
    doc.state[column].push(id);
  });
  return card;
}

/** Writes only the `cards` Map, so a concurrent move cannot affect it. Returns false if the card is gone.
 * @param {BoardDocument} doc @param {string} cardId @param {string} title */
export function renameCard(doc, cardId, title) {
  const next = normalizeTitle(title);
  if (findCard(doc, cardId) === undefined) return false;
  if (doc.state.cards.get(cardId)?.title !== next) doc.state.cards.set(cardId, { title: next });
  return true;
}

/** Removes the card's position and its data in one batch.
 * @param {BoardDocument} doc @param {string} cardId */
export function deleteCard(doc, cardId) {
  const found = findCard(doc, cardId);
  if (found === undefined) return false;
  doc.transact(() => {
    doc.state[found.column].delete(found.index);
    doc.state.cards.delete(cardId);
  });
  return true;
}

/**
 * Moves a card to gap `toIndex` of `toColumn`, counted in the view before the move. There is no List
 * move: one batch deletes the card ID's element and inserts the ID again, as a new element. The
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
    target.insert(insertAt, cardId);
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
      if (operation.type === "map/set" && operation.path === "cards") titles.set(operation.key, operation.value.title);
    }
  }
  /** @type {Card[]} */
  const lost = [];
  for (const operation of commit.operations) {
    if (operation.type !== "map/delete" || operation.path !== "cards") continue;
    const title = titles.get(operation.key);
    if (title !== undefined) lost.push({ id: operation.key, title });
  }
  return lost;
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
    const ids = doc.state[column];
    const cardId = ids.get(index);
    selected = { cardId, column, cursor: ids.cursorAt(index, "right") };
    return { column, index, card: cardFor(doc, cardId) };
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
      const ids = doc.state[selected.column];
      const gap = ids.cursorIndex(selected.cursor);
      if (gap === undefined || ids.length === 0) { selected = undefined; return undefined; }
      return remember(selected.column, Math.min(gap, ids.length - 1));
    },
  };
}
