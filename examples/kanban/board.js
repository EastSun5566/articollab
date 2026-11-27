// @ts-check
// Shared by the page, the server and the tests: no DOM and no network.
import { counterMap, defineDocument, list, map } from "articollab";

/** A card as the page shows it: its ID, which never changes, and its title. @typedef {{ id: string, title: string }} Card */

export const COLUMNS = /** @type {const} */ (["todo", "doing", "done"]);
/** @typedef {(typeof COLUMNS)[number]} Column */

export const MAX_TITLE_LENGTH = 200;

/**
 * A hand-written Standard Schema; Zod, Valibot or ArkType schemas work the same way.
 * @template {import("articollab").JsonValue} T
 * @param {(input: unknown) => input is T} accepts @param {string} message
 * @returns {import("articollab").StandardSchemaV1<T>}
 */
function standardSchema(accepts, message) {
  return { "~standard": { version: 1, vendor: "articollab-kanban",
    validate: (input) => accepts(input) ? { value: input } : { issues: [{ message }] } } };
}

/** A card ID: a non-empty string of up to 100 characters. */
const cardIdSchema = standardSchema(
  /** @returns {input is string} */ (input) => typeof input === "string" && input.length > 0 && input.length <= 100,
  "A card ID needs 1–100 characters");
/** One of the board's columns. */
const columnSchema = standardSchema(
  /** @returns {input is Column} */ (input) => COLUMNS.some((column) => column === input),
  `A column is one of ${COLUMNS.join(", ")}`);
/** A title as `normalizeTitle()` produces it: trimmed, 1–200 characters. */
const titleSchema = standardSchema(
  /** @returns {input is string} */ (input) => typeof input === "string" && input === input.trim() &&
    input.length > 0 && input.length <= MAX_TITLE_LENGTH,
  `A card title needs 1–${MAX_TITLE_LENGTH} characters, without surrounding spaces`);

/**
 * `order` lists every card; each column shows its cards in that order. Moves, column changes and
 * renames touch different collections, so concurrent edits never conflict or duplicate a card.
 */
export const Board = defineDocument({
  order: list(cardIdSchema),
  columns: map(columnSchema),
  titles: map(titleSchema),
  // Votes by card ID: concurrent votes all count, where a `map` of numbers would keep only the last.
  votes: counterMap(),
});
/** @typedef {typeof Board.definition} Shape */
/** @typedef {import("articollab").ClientDocument<Shape>} BoardDocument */

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

/** Removes the card's position, column, title and votes in one batch.
 * @param {BoardDocument} doc @param {string} cardId */
export function deleteCard(doc, cardId) {
  const found = findCard(doc, cardId);
  if (found === undefined) return false;
  doc.transact(() => {
    doc.state.order.delete(found.position);
    doc.state.columns.delete(cardId);
    doc.state.titles.delete(cardId);
    doc.state.votes.delete(cardId);
  });
  return true;
}

/** Adds one vote, or takes one back with -1. Returns false if the card is gone.
 * @param {BoardDocument} doc @param {string} cardId @param {1 | -1} [delta] */
export function voteCard(doc, cardId, delta = 1) {
  if (doc.state.columns.get(cardId) === undefined) return false;
  doc.state.votes.add(cardId, delta);
  return true;
}

/**
 * Moves a card to gap `toIndex` of `toColumn`, counted before the move: a List move, plus a column
 * change between columns. Returns false if the card is gone or would not move.
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
 * What to tell this writer about its edits the server did not apply because another writer deleted
 * the card first: a `transform` event's `dropped` or a `discard` event's `operations`. One message
 * per card and kind, in batch order.
 * @param {readonly import("articollab").DocumentOperation<Shape>[]} operations
 * @returns {string[]}
 */
export function describeDropped(operations) {
  /** @type {Map<string, string>} */
  const messages = new Map();
  for (const operation of operations) {
    if (operation.type === "map/set" && operation.path === "titles") {
      messages.set(`rename:${operation.key}`, `Not saved: “${operation.value}”. Another writer deleted this card.`);
    } else if (operation.type === "counterMap/add") {
      messages.set(`vote:${operation.key}`, "Vote not counted: another writer deleted this card.");
    } else if ((operation.type === "map/set" && operation.path === "columns") || operation.type === "list/move") {
      // A List move names the card's element ID, not its card ID: one move notice per batch is enough.
      messages.set("move", "Not moved: another writer deleted that card.");
    }
  }
  return [...messages.values()];
}

/**
 * Calls `listener` with each message about this writer's edits the server dropped, from undo and
 * restored batches too. A dropped move can show up in both events of one commit; it is told once.
 * @param {BoardDocument} doc @param {(message: string) => void} listener
 * @returns {() => void} Stops listening.
 */
export function onDroppedEdits(doc, listener) {
  let commit = -1;
  /** @type {Set<string>} */
  let told = new Set();
  /** @param {number} serverSeq @param {readonly import("articollab").DocumentOperation<Shape>[]} operations */
  const tell = (serverSeq, operations) => {
    if (serverSeq !== commit) { commit = serverSeq; told = new Set(); }
    for (const message of describeDropped(operations)) {
      if (told.has(message)) continue;
      told.add(message);
      listener(message);
    }
  };
  const stopTransform = doc.on("transform", (event) => { tell(event.commit.serverSeq, event.dropped); });
  // A List move of a deleted card changes nothing, so the commit still matches the batch: `discard` reports it.
  const stopDiscard = doc.on("discard", (event) => { tell(event.commit.serverSeq, event.operations); });
  return () => { stopTransform(); stopDiscard(); };
}

/**
 * The selected card, followed by ID; once it is deleted, a cursor at its old place picks the
 * nearest card of the same column.
 * @param {BoardDocument} doc
 */
export function createSelection(doc) {
  /** @type {{cardId: string, column: Column, cursor: import("articollab").Cursor} | undefined} */
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
