import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient, type DocumentOperation, type ServerCommit, type ServerDocument } from "../../../dist/index.js";
import { addCard, Board, COLUMNS, deleteCard, findCard, moveCard, renameCard, type Shape } from "../board.js";
import { resolveBoard } from "../policy.ts";
import { createBoardServer } from "../server.ts";

/** Explicit, ordered delivery: tests decide when each writer sends and receives. */
function network(server: ServerDocument<Shape> = createBoardServer()) {
  const log: ServerCommit<DocumentOperation<Shape>>[] = [];
  function writer() {
    let sent = 0, received = server.snapshot().serverSeq;
    const discards: string[] = [];
    const doc = createClient(Board, { clientId: server.openClient(), snapshot: server.snapshot(), onBatch() {} });
    doc.on("discard", ({ operations }) => { for (const operation of operations) discards.push(operation.value.title); });
    return {
      doc, discards,
      /** Sends the next unsent pending batch, as the sync engine does: never past a replay conflict. */
      send() {
        const batch = doc.checkpoint().pendingBatches.find(({ seq }) => seq > sent);
        assert.ok(batch !== undefined, "a batch to send");
        assert.equal(doc.replayConflict, null);
        sent = batch.seq;
        const { commit } = server.receive(batch);
        log.push(commit);
        return commit;
      },
      /** Receives every commit it has not seen yet, in order. */
      receive(upTo = log.length) {
        for (const commit of log.slice(0, upTo)) {
          if (commit.serverSeq <= received) continue;
          doc.receive(commit);
          received = commit.serverSeq;
        }
      },
      board: () => COLUMNS.map((column) => doc.state[column].toArray()),
      count: (cardId: string) => COLUMNS.reduce((total, column) => total + doc.state[column].toArray().filter(({ id }) => id === cardId).length, 0),
    };
  }
  return { server, log, writer };
}

function serverBoard(server: ServerDocument<Shape>) {
  const { data } = server.snapshot();
  return COLUMNS.map((column) => data[column].values);
}

describe("Kanban move policy", () => {
  it("keeps the first of two concurrent moves of one card, after a transient duplicate on the later writer", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(moveCard(a.doc, "seed-drag", "done", 0));
    assert.ok(moveCard(b.doc, "seed-drag", "todo", 0));
    a.send();
    const late = b.send();
    assert.deepEqual(late.operations.map(({ type }) => type), ["list/delete"], "the later move lost its insertion");
    b.receive(1);
    assert.equal(b.count("seed-drag"), 2, "B replays its move over A's until its own commit arrives");
    a.receive(); b.receive();
    for (const writer of [a, b]) {
      assert.equal(writer.count("seed-drag"), 1);
      assert.equal(findCard(writer.doc, "seed-drag")?.column, "done");
      assert.deepEqual(writer.board(), serverBoard(n.server));
      assert.equal(writer.doc.checkpoint().pendingBatches.length, 0);
    }
  });

  it("moves a rename aimed at a card's old element to where the card is now", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(moveCard(a.doc, "seed-tests", "done", 1));
    assert.ok(renameCard(b.doc, "seed-tests", "Write policy tests"));
    a.send();
    const rename = b.send();
    const moved = findCard(a.doc, "seed-tests");
    assert.ok(moved !== undefined);
    assert.deepEqual(rename.operations, [{ type: "list/set", path: "done",
      id: a.doc.state.done.cursorAt(moved.index, "right").anchor, value: { id: "seed-tests", title: "Write policy tests" } }]);
    a.receive(); b.receive();
    for (const writer of [a, b]) {
      assert.deepEqual(findCard(writer.doc, "seed-tests"), { column: "done", index: 1, card: { id: "seed-tests", title: "Write policy tests" } });
      assert.deepEqual(writer.board(), serverBoard(n.server));
    }
    assert.deepEqual(b.discards, [], "nothing was lost");
  });

  it("reports a rename of a card that another writer deleted as a discard, without bringing it back", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(deleteCard(a.doc, "seed-sketch"));
    assert.ok(renameCard(b.doc, "seed-sketch", "Too late"));
    a.send(); b.send();
    a.receive(); b.receive();
    assert.deepEqual(b.discards, ["Too late"]);
    assert.deepEqual(a.discards, []);
    for (const writer of [a, b]) {
      assert.equal(writer.count("seed-sketch"), 0);
      assert.deepEqual(writer.board(), serverBoard(n.server));
    }
  });

  it("does not let a concurrent move bring back a deleted card", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(deleteCard(a.doc, "seed-drag"));
    assert.ok(moveCard(b.doc, "seed-drag", "done", 0));
    a.send(); b.send();
    a.receive(); b.receive();
    for (const writer of [a, b]) {
      assert.equal(writer.count("seed-drag"), 0);
      assert.deepEqual(writer.board(), serverBoard(n.server));
    }
  });

  it("accepts ordinary batches unchanged", () => {
    const server = createBoardServer();
    const batches: Parameters<typeof resolveBoard>[0]["batch"][] = [];
    const doc = createClient(Board, { clientId: server.openClient(), snapshot: server.snapshot(), onBatch(batch) { batches.push(batch); } });
    const snapshot = server.snapshot();
    addCard(doc, "todo", "New", "new-card");
    moveCard(doc, "seed-drag", "done", 1);
    moveCard(doc, "seed-tests", "todo", 0);
    renameCard(doc, "seed-ship", "Shipped");
    deleteCard(doc, "seed-sketch");
    assert.equal(batches.length, 5);
    for (const batch of batches) assert.equal(resolveBoard({ batch, snapshot }), batch.operations);
  });

  it("blocks a follow-up edit to a move that the server dropped until it is rejected", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(moveCard(a.doc, "seed-drag", "done", 0));
    assert.ok(moveCard(b.doc, "seed-drag", "todo", 0));
    assert.ok(renameCard(b.doc, "seed-drag", "Renamed after my move"));
    a.send(); b.send();
    b.receive();
    assert.notEqual(b.doc.replayConflict, null, "the rename targets B's dropped insertion");
    assert.throws(() => addCard(b.doc, "todo", "Blocked"));
    const blocked = b.doc.checkpoint().pendingBatches[0]!;
    n.log.push(n.server.reject(blocked).commit);
    a.receive(); b.receive();
    assert.equal(b.doc.replayConflict, null);
    for (const writer of [a, b]) {
      assert.equal(findCard(writer.doc, "seed-drag")?.card.title, "Drag cards between columns");
      assert.deepEqual(writer.board(), serverBoard(n.server));
    }
  });
});
