// @ts-check
// Shared by the page, the server and the tests: no DOM and no network.
import { defineDocument, list, map } from "../../dist/index.js";

/** A card as the page shows it: its ID, which never changes, and its title. @typedef {{ id: string, title: string }} Card */

export const COLUMNS = /** @type {const} */ (["todo", "doing", "done"]);
/** @typedef {(typeof COLUMNS)[number]} Column */

export const MAX_TITLE_LENGTH = 200;

/**
 * A hand-written Standard Schema: `check` returns why a value is invalid, or undefined. Zod,
 * Valibot or ArkType schemas work the same way; this example avoids the dependency.
 * @template {import("../../dist/index.js").JsonValue} T
 * @param {(input: unknown) => input is T} accepts @param {string} message
 * @returns {import("../../dist/index.js").StandardSchemaV1<T>}
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
 * One List orders every card, a Map records each card's column and another its title. Each column
 * shows the cards of that column in `order`. Moving a card is a List move plus, between columns, a
 * column change; renaming touches only `titles`. Each part is decided by server order on its own,
 * so concurrent moves, column changes and renames never conflict or duplicate a card. The schemas
 * validate every value written, here and on the server, so no writer can store a bad column or title.
 */
export const Board = defineDocument({
  order: list(cardIdSchema),
  columns: map(columnSchema),
  titles: map(titleSchema),
});
/** @typedef {typeof Board.definition} Shape */
/** @typedef {import("../../dist/index.js").ClientDocument<Shape>} BoardDocument */

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
 * The edits the server dropped from this writer's batch, by card: the policy drops a rename or a
 * column change of a card that another writer deleted first. Call it with a `transform` event's
 * `dropped` operations. Same-column moves of a deleted card are reported by `discard` instead.
 * @param {readonly import("../../dist/index.js").DocumentOperation<Shape>[]} dropped
 * @returns {{ kind: "rename" | "move", id: string, title?: string }[]} In batch order, at most one of each kind per card.
 */
export function droppedEdits(dropped) {
  /** @type {Map<string, { kind: "rename" | "move", id: string, title?: string }>} */
  const edits = new Map();
  for (const operation of dropped) {
    if (operation.type !== "map/set") continue;
    if (operation.path === "titles") edits.set(`rename:${operation.key}`, { kind: "rename", id: operation.key, title: operation.value });
    else if (operation.path === "columns" && !edits.has(`move:${operation.key}`)) edits.set(`move:${operation.key}`, { kind: "move", id: operation.key });
  }
  return [...edits.values()];
}

/**
 * The rename a batch's outcome lost, if the policy dropped it because another writer deleted the
 * card first: the last title the batch set.
 * @param {import("../../dist/index.js").BatchOutcome<import("../../dist/index.js").DocumentOperation<Shape>>} outcome
 * @returns {Card | undefined}
 */
export function lostRename(outcome) {
  const edit = droppedEdits(outcome.dropped).find(({ kind }) => kind === "rename");
  return edit === undefined ? undefined : { id: edit.id, title: edit.title ?? "" };
}

/**
 * Tells this writer, through `notify`, about its edits the server did not apply. Moves of cards
 * another writer deleted first are reported from the document's events; a cross-column move is
 * both transformed and discarded, but is reported once. Renames are reported per batch through
 * `follow()`. Edits cancelled through `cancel()` are not reported.
 * @param {BoardDocument} doc @param {(message: string) => void} notify
 */
export function watchDroppedEdits(doc, notify) {
  let cancelling = false, movedNotice = -1;
  /** @param {number} serverSeq */
  const notMoved = (serverSeq) => {
    if (movedNotice === serverSeq) return;
    movedNotice = serverSeq;
    notify("Not moved: another writer deleted that card.");
  };
  const stopTransform = doc.on("transform", ({ commit, dropped }) => {
    if (cancelling) return;
    for (const edit of droppedEdits(dropped)) if (edit.kind === "move") notMoved(commit.serverSeq);
  });
  // A List move of a deleted card changed nothing; the server reports it on acknowledgement.
  const stopDiscard = doc.on("discard", ({ commit, operations }) => {
    if (!cancelling && operations.some((operation) => operation.type === "list/move")) notMoved(commit.serverSeq);
  });
  return {
    /**
     * Reports the rename a tracked batch loses, once the server has decided; from `doc.track()` or,
     * for a batch restored from a checkpoint, `doc.settled(batch)`.
     * @param {Promise<import("../../dist/index.js").BatchOutcome<import("../../dist/index.js").DocumentOperation<Shape>> | undefined>} settled
     */
    follow(settled) {
      void settled.then((outcome) => {
        const lost = outcome === undefined || cancelling ? undefined : lostRename(outcome);
        if (lost !== undefined) notify(`Not saved: “${lost.title}”. Another writer deleted this card.`);
      });
    },
    /**
     * Runs the writer's own cancellation, such as `sync.rejectPending()`, without reporting it.
     * @template T @param {() => Promise<T>} cancellation @returns {Promise<T>}
     */
    async cancel(cancellation) {
      cancelling = true;
      try { return await cancellation(); } finally { cancelling = false; }
    },
    stop() { stopTransform(); stopDiscard(); },
  };
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
