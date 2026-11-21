import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient, type DocumentOperation, type ServerCommit, type ServerDocument } from "../../../dist/index.js";
import { addCard, Board, COLUMNS, deleteCard, findCard, lostRenames, moveCard, renameCard, type Shape } from "../board.js";
import { resolveBoard } from "../policy.ts";
import { createBoardServer } from "../server.ts";

/** Explicit, ordered delivery: tests decide when each writer sends and receives. */
function network(server: ServerDocument<Shape> = createBoardServer()) {
  const log: ServerCommit<DocumentOperation<Shape>>[] = [];
  function writer() {
    let sent = 0, received = server.snapshot().serverSeq;
    const lost: string[] = [];
    const doc = createClient(Board, { clientId: server.openClient(), snapshot: server.snapshot(), onBatch() {} });
    const clientId = doc.checkpoint().clientId;
    return {
      doc, lost,
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
      /** Receives every commit it has not seen yet, in order, checking peers' commits for lost renames. */
      receive(upTo = log.length) {
        for (const commit of log.slice(0, upTo)) {
          if (commit.serverSeq <= received) continue;
          doc.receive(commit);
          received = commit.serverSeq;
          if (commit.source.clientId !== clientId) {
            for (const card of lostRenames(commit, doc.checkpoint().pendingBatches)) lost.push(card.title);
          }
        }
      },
      board: () => COLUMNS.map((column) => doc.state[column].toArray()),
      cards: () => doc.state.cards.toObject(),
      count: (cardId: string) => COLUMNS.reduce((total, column) => total + doc.state[column].toArray().filter((id) => id === cardId).length, 0),
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

  it("applies a rename and a concurrent move to the same card unchanged", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(moveCard(a.doc, "seed-tests", "done", 1));
    assert.ok(renameCard(b.doc, "seed-tests", "Write policy tests"));
    const move = a.send(), rename = b.send();
    assert.deepEqual(rename.operations, [{ type: "map/set", path: "cards", key: "seed-tests", value: { title: "Write policy tests" } }],
      "the rename writes the Map, which the move never touched");
    assert.equal(move.operations.length, 2);
    a.receive(); b.receive();
    for (const writer of [a, b]) {
      assert.deepEqual(findCard(writer.doc, "seed-tests"), { column: "done", index: 1, card: { id: "seed-tests", title: "Write policy tests" } });
      assert.deepEqual(writer.board(), serverBoard(n.server));
    }
    assert.deepEqual(b.lost, []);
  });

  it("drops a rename of a card another writer deleted, leaves no orphan data, and reports it as lost", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(deleteCard(a.doc, "seed-sketch"));
    assert.ok(renameCard(b.doc, "seed-sketch", "Too late"));
    a.send();
    b.receive();
    assert.deepEqual(b.lost, ["Too late"], "B learns from A's delete that its pending rename will be dropped");
    const dropped = b.send();
    assert.deepEqual(dropped.operations, []);
    a.receive(); b.receive();
    assert.deepEqual(a.lost, []);
    for (const writer of [a, b]) {
      assert.equal(writer.count("seed-sketch"), 0);
      assert.equal(writer.doc.state.cards.has("seed-sketch"), false);
      assert.deepEqual(writer.board(), serverBoard(n.server));
    }
    assert.equal(Object.hasOwn(n.server.snapshot().data.cards, "seed-sketch"), false, "no data without a position");
  });

  it("keeps a rename that reached the server before the delete, and reports nothing", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(renameCard(b.doc, "seed-sketch", "In time"));
    b.send();
    assert.ok(deleteCard(a.doc, "seed-sketch"));
    a.send();
    a.receive(); b.receive();
    assert.deepEqual([a.lost, b.lost], [[], []]);
    assert.equal(n.server.snapshot().data.cards["seed-sketch"], undefined);
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

  it("tracks card data within one batch: a set after the card's own delete is dropped", () => {
    const server = createBoardServer();
    const snapshot = server.snapshot();
    const batch = { clientId: "client-9", seq: 1, operations: [
      { type: "map/delete", path: "cards", key: "seed-ship" },
      { type: "map/set", path: "cards", key: "seed-ship", value: { title: "Orphan" } },
    ] } as const;
    assert.deepEqual(resolveBoard({ batch, snapshot }), [batch.operations[0]]);
  });

  it("blocks a follow-up move of a card whose move the server dropped until it is rejected", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(moveCard(a.doc, "seed-drag", "done", 0));
    assert.ok(moveCard(b.doc, "seed-drag", "todo", 0));
    assert.ok(moveCard(b.doc, "seed-drag", "todo", 2), "moves B's own, not yet confirmed, element");
    a.send(); b.send();
    b.receive();
    assert.notEqual(b.doc.replayConflict, null, "the second move deletes B's dropped insertion");
    assert.throws(() => addCard(b.doc, "todo", "Blocked"));
    const blocked = b.doc.checkpoint().pendingBatches[0]!;
    n.log.push(n.server.reject(blocked).commit);
    a.receive(); b.receive();
    assert.equal(b.doc.replayConflict, null);
    for (const writer of [a, b]) {
      assert.equal(writer.count("seed-drag"), 1);
      assert.deepEqual(writer.board(), serverBoard(n.server));
    }
  });
});

describe("Lost renames", () => {
  it("names only cards a commit deletes that have pending renames, with the last pending title", () => {
    const pending = [
      { clientId: "c", seq: 1, operations: [{ type: "map/set", path: "cards", key: "x", value: { title: "first" } }] },
      { clientId: "c", seq: 2, operations: [{ type: "map/set", path: "cards", key: "x", value: { title: "last" } },
        { type: "map/set", path: "cards", key: "kept", value: { title: "kept" } }] },
    ] as const;
    const commit = { serverSeq: 9, source: { clientId: "peer", seq: 1 }, operations: [
      { type: "list/delete", path: "todo", id: { bunchId: "b", counter: 0 } },
      { type: "map/delete", path: "cards", key: "x" },
      { type: "map/delete", path: "cards", key: "unrelated" },
    ] } as const;
    assert.deepEqual(lostRenames(commit, pending), [{ id: "x", title: "last" }]);
    assert.deepEqual(lostRenames(commit, []), []);
  });
});
