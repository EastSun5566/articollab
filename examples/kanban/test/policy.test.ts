import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient, type DocumentOperation, type ServerCommit, type ServerDocument } from "../../../dist/index.js";
import {
  addCard, Board, cardsIn, COLUMNS, deleteCard, findCard, lostRenames, moveCard, renameCard, type Shape,
} from "../board.js";
import { resolveBoard } from "../policy.ts";
import { createBoardServer } from "../server.ts";

/** Explicit, ordered delivery: tests decide when each writer sends and receives. */
function network(server: ServerDocument<Shape> = createBoardServer()) {
  const log: ServerCommit<DocumentOperation<Shape>>[] = [];
  function writer() {
    let sent = 0, received = server.snapshot().serverSeq;
    const lost: string[] = [];
    const discarded: string[] = [];
    const doc = createClient(Board, { clientId: server.openClient(), snapshot: server.snapshot(), onBatch() {} });
    const clientId = doc.checkpoint().clientId;
    doc.on("discard", ({ operations }) => { for (const { type } of operations) discarded.push(type); });
    return {
      doc, lost, discarded,
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
      receive() {
        for (const commit of log) {
          if (commit.serverSeq <= received) continue;
          doc.receive(commit);
          received = commit.serverSeq;
          if (commit.source.clientId !== clientId) {
            for (const card of lostRenames(commit, doc.checkpoint().pendingBatches)) lost.push(card.title);
          }
        }
      },
      board: () => [doc.state.order.toArray(), doc.state.columns.toObject(), doc.state.titles.toObject()],
      columns: () => COLUMNS.map((column) => cardsIn(doc, column)),
    };
  }
  return { server, writer };
}

function serverBoard(server: ServerDocument<Shape>) {
  const { data } = server.snapshot();
  return [data.order.values, data.columns, data.titles];
}

describe("Kanban board under concurrent edits", () => {
  it("keeps one copy of a card two writers move at once, without any policy", () => {
    const n = network(), first = n.writer(), second = n.writer();
    assert.ok(moveCard(first.doc, "seed-drag", "done", 0));
    assert.ok(moveCard(second.doc, "seed-drag", "todo", 0));
    const commits = [first.send(), second.send()];
    for (const commit of commits) assert.notEqual(commit.operations.length, 0, "nothing was dropped");
    first.receive(); second.receive();
    for (const writer of [first, second]) {
      assert.deepEqual(writer.columns(), [["seed-drag", "seed-sketch", "seed-tests"], [], ["seed-ship"]], "the later move wins");
      assert.deepEqual(writer.board(), serverBoard(n.server));
    }
    assert.equal(n.server.snapshot().data.order.values.filter((id) => id === "seed-drag").length, 1);
  });

  it("applies a rename and a concurrent move to the same card", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(moveCard(a.doc, "seed-tests", "done", 1));
    assert.ok(renameCard(b.doc, "seed-tests", "Write policy tests"));
    a.send(); b.send();
    a.receive(); b.receive();
    for (const writer of [a, b]) {
      assert.deepEqual(findCard(writer.doc, "seed-tests")?.card, { id: "seed-tests", title: "Write policy tests" });
      assert.equal(findCard(writer.doc, "seed-tests")?.column, "done");
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
    assert.deepEqual(b.send().operations, []);
    a.receive(); b.receive();
    for (const writer of [a, b]) {
      assert.equal(findCard(writer.doc, "seed-sketch"), undefined);
      assert.equal(writer.doc.state.titles.has("seed-sketch"), false);
      assert.deepEqual(writer.board(), serverBoard(n.server));
    }
  });

  it("reports a move of a card another writer deleted through discard, with no orphan column", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(deleteCard(a.doc, "seed-drag"));
    assert.ok(moveCard(b.doc, "seed-drag", "done", 1)); // After seed-ship: a List move and a column change.
    a.send();
    const late = b.send();
    assert.deepEqual(late.operations.map(({ type }) => type), ["list/move"], "the column change was dropped");
    a.receive(); b.receive();
    assert.deepEqual(b.discarded, ["list/move"]);
    for (const writer of [a, b]) {
      assert.equal(findCard(writer.doc, "seed-drag"), undefined);
      assert.equal(writer.doc.state.columns.has("seed-drag"), false);
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
});

describe("Lost renames", () => {
  it("names only cards a commit deletes that have pending renames, with the last pending title", () => {
    const pending = [
      { clientId: "c", seq: 1, operations: [{ type: "map/set", path: "titles", key: "x", value: "first" }] },
      { clientId: "c", seq: 2, operations: [{ type: "map/set", path: "titles", key: "x", value: "last" },
        { type: "map/set", path: "titles", key: "kept", value: "kept" },
        { type: "map/set", path: "columns", key: "y", value: "done" }] },
    ] as const;
    const commit = { serverSeq: 9, source: { clientId: "peer", seq: 1 }, operations: [
      { type: "list/delete", path: "order", id: { bunchId: "b", counter: 0 } },
      { type: "map/delete", path: "titles", key: "x" },
      { type: "map/delete", path: "titles", key: "unrelated" },
      { type: "map/delete", path: "columns", key: "y" },
    ] } as const;
    assert.deepEqual(lostRenames(commit, pending), [{ id: "x", title: "last" }]);
    assert.deepEqual(lostRenames(commit, []), []);
  });
});
