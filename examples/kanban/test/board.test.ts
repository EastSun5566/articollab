import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient, type ClientBatch, type DocumentOperation } from "../../../dist/index.js";
import {
  addCard, Board, COLUMNS, createSelection, deleteCard, findCard, MAX_TITLE_LENGTH, moveCard, normalizeTitle, renameCard,
  type Shape,
} from "../board.js";
import { createBoardServer } from "../server.ts";
import { observeColumn } from "../view.js";

/** One writer whose batches the server applies immediately. */
function writer(server = createBoardServer()) {
  const batches: ClientBatch<DocumentOperation<Shape>>[] = [];
  const doc = createClient(Board, { clientId: server.openClient(), snapshot: server.snapshot(),
    onBatch(batch) { batches.push(batch); doc.receive(server.receive(batch).commit); } });
  const ids = (column: (typeof COLUMNS)[number]) => doc.state[column].toArray();
  return { server, doc, batches, ids };
}

describe("Kanban board helpers", () => {
  it("moves a card with exactly one delete and one insert, counting gaps before the move", () => {
    const w = writer();
    assert.deepEqual(w.ids("todo"), ["seed-sketch", "seed-tests"]);
    assert.equal(moveCard(w.doc, "seed-sketch", "todo", 0), false, "same gap");
    assert.equal(moveCard(w.doc, "seed-sketch", "todo", 1), false, "the gap just after itself");
    assert.equal(w.batches.length, 0);
    assert.ok(moveCard(w.doc, "seed-sketch", "todo", 2));
    assert.deepEqual(w.ids("todo"), ["seed-tests", "seed-sketch"]);
    assert.deepEqual(w.batches.at(-1)!.operations.map(({ type, path }) => [type, path]), [["list/delete", "todo"], ["list/insert", "todo"]]);
    assert.ok(moveCard(w.doc, "seed-sketch", "todo", 0));
    assert.deepEqual(w.ids("todo"), ["seed-sketch", "seed-tests"]);
    assert.ok(moveCard(w.doc, "seed-tests", "done", 0));
    assert.deepEqual([w.ids("todo"), w.ids("done")], [["seed-sketch"], ["seed-tests", "seed-ship"]]);
    assert.deepEqual(w.batches.at(-1)!.operations.map(({ type, path }) => [type, path]), [["list/delete", "todo"], ["list/insert", "done"]]);
    assert.equal(w.batches.length, 3);
    for (const gap of [-1, 1.5, 3]) assert.throws(() => moveCard(w.doc, "seed-drag", "done", gap), RangeError);
    assert.equal(moveCard(w.doc, "missing", "done", 0), false);
    assert.equal(w.batches.length, 3);
  });

  it("validates titles and skips unchanged renames", () => {
    assert.equal(normalizeTitle("  Card  "), "Card");
    for (const title of ["", "   ", "x".repeat(MAX_TITLE_LENGTH + 1)]) assert.throws(() => normalizeTitle(title), RangeError);
    const w = writer();
    assert.throws(() => addCard(w.doc, "todo", " "), RangeError);
    assert.equal(addCard(w.doc, "todo", " New ", "new").title, "New");
    assert.deepEqual(w.batches.at(-1)!.operations.map(({ type, path }) => [type, path]), [["map/set", "cards"], ["list/insert", "todo"]],
      "a new card's data and position travel in one batch");
    assert.ok(addCard(w.doc, "todo", "Random").id.length > 0);
    assert.ok(renameCard(w.doc, "new", "New"));
    assert.equal(w.batches.length, 2, "an unchanged title records no write");
    assert.ok(renameCard(w.doc, "new", "Renamed"));
    assert.deepEqual(w.batches.at(-1)!.operations, [{ type: "map/set", path: "cards", key: "new", value: { title: "Renamed" } }]);
    assert.deepEqual(findCard(w.doc, "new"), { column: "todo", index: 2, card: { id: "new", title: "Renamed" } });
    assert.equal(renameCard(w.doc, "missing", "x"), false);
    assert.equal(deleteCard(w.doc, "missing"), false);
    assert.ok(deleteCard(w.doc, "new"));
    assert.deepEqual(w.batches.at(-1)!.operations.map(({ type, path }) => [type, path]), [["list/delete", "todo"], ["map/delete", "cards"]]);
    assert.equal(findCard(w.doc, "new"), undefined);
    assert.equal(w.doc.state.cards.has("new"), false);
  });

  it("keeps observed columns and titles equal to the document, with a rename touching only the Map", () => {
    const w = writer();
    const peer = createClient(Board, { clientId: w.server.openClient(), snapshot: w.server.snapshot(),
      onBatch(batch) { const { commit } = w.server.receive(batch); peer.receive(commit); w.doc.receive(commit); } });
    const rows = new Map<string, string[]>(), calls: string[] = [];
    const stops = COLUMNS.map((column) => {
      const ids: string[] = [];
      rows.set(column, ids);
      return observeColumn(w.doc.state[column], {
        insert(index, id) { ids.splice(index, 0, id); calls.push("insert"); },
        remove(index) { ids.splice(index, 1); calls.push("remove"); },
        update(index, id) { ids[index] = id; calls.push("update"); },
      });
    });
    const titles = new Map([...w.doc.state.cards].map(([id, { title }]) => [id, title]));
    stops.push(w.doc.state.cards.observe(({ changes }) => {
      for (const change of changes) {
        if (change.type === "set") titles.set(change.key, change.value.title);
        else titles.delete(change.key);
        calls.push("title");
      }
    }));
    const same = () => {
      for (const column of COLUMNS) assert.deepEqual(rows.get(column), w.doc.state[column].toArray(), column);
      assert.deepEqual(Object.fromEntries(titles), Object.fromEntries([...w.doc.state.cards].map(([id, { title }]) => [id, title])));
    };
    same();
    addCard(peer, "doing", "From a peer", "remote"); // This writer only receives it.
    same();
    calls.length = 0;
    renameCard(w.doc, "seed-drag", "Renamed");
    assert.deepEqual(calls, ["title"], "a rename leaves every column untouched");
    calls.length = 0;
    moveCard(w.doc, "seed-drag", "done", 0);
    assert.deepEqual(calls.toSorted(), ["insert", "remove"], "a move leaves the title untouched");
    moveCard(w.doc, "seed-sketch", "todo", 2);
    addCard(w.doc, "done", "Added", "added");
    deleteCard(w.doc, "seed-ship");
    same();
    for (const stop of stops) stop();
    renameCard(w.doc, "added", "After stop");
    assert.equal(titles.get("added"), "Added", "stopped observers are not updated");
  });

  it("follows a selected card by ID and falls back to its neighbour once it is deleted", () => {
    const w = writer();
    const selection = createSelection(w.doc);
    assert.equal(selection.resolve(), undefined);
    assert.equal(selection.select("missing"), undefined);
    assert.equal(selection.select("seed-sketch")?.index, 0);
    moveCard(w.doc, "seed-sketch", "done", 1);
    assert.deepEqual(selection.resolve(), { column: "done", index: 1, card: { id: "seed-sketch", title: "Sketch the release notes" } });
    addCard(w.doc, "done", "Last", "last");
    deleteCard(w.doc, "seed-sketch");
    assert.equal(selection.resolve()?.card.id, "last", "the card after the deleted one");
    deleteCard(w.doc, "last");
    assert.equal(selection.resolve()?.card.id, "seed-ship", "the card before, at the end of the column");
    assert.equal(selection.cardId, "seed-ship");
    deleteCard(w.doc, "seed-ship");
    assert.equal(selection.resolve(), undefined, "the column is empty");
    assert.equal(selection.cardId, undefined);
    selection.select("seed-drag");
    selection.clear();
    assert.equal(selection.resolve(), undefined);
  });
});
