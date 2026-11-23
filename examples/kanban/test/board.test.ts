import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient, type ClientBatch, type DocumentOperation } from "../../../dist/index.js";
import {
  addCard, Board, cardsIn, COLUMNS, createSelection, deleteCard, findCard, MAX_TITLE_LENGTH, moveCard, normalizeTitle,
  renameCard, type Shape,
} from "../board.js";
import { createBoardServer } from "../server.ts";

/** One writer whose batches the server applies immediately. */
function writer(server = createBoardServer()) {
  const batches: ClientBatch<DocumentOperation<Shape>>[] = [];
  const doc = createClient(Board, { clientId: server.openClient(), snapshot: server.snapshot(),
    onBatch(batch) { batches.push(batch); doc.receive(server.receive(batch).commit); } });
  const ids = (column: (typeof COLUMNS)[number]) => cardsIn(doc, column);
  const types = () => batches.at(-1)!.operations.map(({ type, path }) => `${type} ${path}`);
  return { server, doc, batches, ids, types };
}

describe("Kanban board helpers", () => {
  it("reorders within a column with one List move, counting gaps before the move", () => {
    const w = writer();
    assert.deepEqual(w.ids("todo"), ["seed-sketch", "seed-tests"]);
    assert.equal(moveCard(w.doc, "seed-sketch", "todo", 0), false, "same gap");
    assert.equal(moveCard(w.doc, "seed-sketch", "todo", 1), false, "the gap just after itself");
    assert.equal(w.batches.length, 0);
    assert.ok(moveCard(w.doc, "seed-sketch", "todo", 2));
    assert.deepEqual(w.ids("todo"), ["seed-tests", "seed-sketch"]);
    assert.deepEqual(w.types(), ["list/move order"]);
    assert.ok(moveCard(w.doc, "seed-sketch", "todo", 0));
    assert.deepEqual(w.ids("todo"), ["seed-sketch", "seed-tests"]);
    for (const gap of [-1, 1.5, 3]) assert.throws(() => moveCard(w.doc, "seed-drag", "doing", gap), RangeError);
    assert.equal(moveCard(w.doc, "missing", "done", 0), false);
  });

  it("moves between columns with a List move and a column change, or the column change alone", () => {
    const w = writer();
    assert.ok(moveCard(w.doc, "seed-tests", "done", 0));
    assert.deepEqual([w.ids("todo"), w.ids("done")], [["seed-sketch"], ["seed-tests", "seed-ship"]]);
    assert.deepEqual(w.types(), ["list/move order", "map/set columns"]);
    // seed-drag already sits between todo's cards and done's in board order.
    assert.ok(moveCard(w.doc, "seed-drag", "todo", 1));
    assert.deepEqual(w.ids("todo"), ["seed-sketch", "seed-drag"]);
    assert.deepEqual(w.types(), ["map/set columns"], "no List move when the order already fits");
    assert.ok(moveCard(w.doc, "seed-drag", "doing", 0));
    assert.deepEqual([w.ids("todo"), w.ids("doing")], [["seed-sketch"], ["seed-drag"]]);
    assert.ok(moveCard(w.doc, "seed-sketch", "doing", 1), "to the end of a column");
    assert.deepEqual(w.ids("doing"), ["seed-drag", "seed-sketch"]);
    assert.ok(moveCard(w.doc, "seed-drag", "todo", 0), "into an empty column");
    assert.deepEqual([w.ids("todo"), w.ids("doing")], [["seed-drag"], ["seed-sketch"]]);
  });

  it("writes a new card in one batch, renames through titles only and deletes all four parts", () => {
    assert.equal(normalizeTitle("  Card  "), "Card");
    for (const title of ["", "   ", "x".repeat(MAX_TITLE_LENGTH + 1)]) assert.throws(() => normalizeTitle(title), RangeError);
    const w = writer();
    assert.throws(() => addCard(w.doc, "todo", " "), RangeError);
    assert.equal(addCard(w.doc, "todo", " New ", "new").title, "New");
    assert.deepEqual(w.types(), ["map/set titles", "map/set columns", "list/insert order"]);
    assert.ok(addCard(w.doc, "todo", "Random").id.length > 0);
    assert.ok(renameCard(w.doc, "new", "New"));
    assert.equal(w.batches.length, 2, "an unchanged title records no write");
    assert.ok(renameCard(w.doc, "new", "Renamed"));
    assert.deepEqual(w.batches.at(-1)!.operations, [{ type: "map/set", path: "titles", key: "new", value: "Renamed" }]);
    assert.deepEqual(findCard(w.doc, "new"), { column: "todo", index: 2, position: 4, card: { id: "new", title: "Renamed" } });
    assert.equal(renameCard(w.doc, "missing", "x"), false);
    assert.equal(deleteCard(w.doc, "missing"), false);
    assert.ok(deleteCard(w.doc, "new"));
    assert.deepEqual(w.types(), ["list/delete order", "map/delete columns", "map/delete titles", "counterMap/delete votes"]);
    assert.equal(findCard(w.doc, "new"), undefined);
    assert.equal(w.doc.state.titles.has("new"), false);
  });

  it("follows a selected card by ID and falls back to a neighbour in its column once it is deleted", () => {
    const w = writer();
    const selection = createSelection(w.doc);
    assert.equal(selection.resolve(), undefined);
    assert.equal(selection.select("missing"), undefined);
    assert.equal(selection.select("seed-sketch")?.index, 0);
    moveCard(w.doc, "seed-sketch", "done", 1);
    assert.deepEqual(selection.resolve(), { column: "done", index: 1, card: { id: "seed-sketch", title: "Sketch the release notes" } });
    addCard(w.doc, "done", "Last", "last");
    deleteCard(w.doc, "seed-sketch");
    assert.equal(selection.resolve()?.card.id, "last", "the next card of the column");
    deleteCard(w.doc, "last");
    assert.equal(selection.resolve()?.card.id, "seed-ship", "the previous card, at the end of the column");
    assert.equal(selection.cardId, "seed-ship");
    deleteCard(w.doc, "seed-ship");
    assert.equal(selection.resolve(), undefined, "the column is empty");
    assert.equal(selection.cardId, undefined);
    selection.select("seed-drag");
    selection.clear();
    assert.equal(selection.resolve(), undefined);
  });
});
