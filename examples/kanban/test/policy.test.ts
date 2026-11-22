import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient, createUndoManager, decodeClientCheckpoint, type DocumentOperation, type ServerCommit, type ServerDocument } from "../../../dist/index.js";
import {
  addCard, Board, cardsIn, COLUMNS, deleteCard, droppedEdits, findCard, moveCard, renameCard, watchDroppedEdits, type Shape,
} from "../board.js";
import { resolveBoard } from "../policy.ts";
import { createBoardServer } from "../server.ts";

/** Explicit, ordered delivery: tests decide when each writer sends and receives. */
function network(server: ServerDocument<Shape> = createBoardServer()) {
  const log: ServerCommit<DocumentOperation<Shape>>[] = [];
  function writer() {
    let sent = 0, received = server.snapshot().serverSeq;
    const notices: string[] = [];
    const discarded: string[] = [];
    const doc = createClient(Board, { clientId: server.openClient(), snapshot: server.snapshot(), onBatch() {} });
    doc.on("discard", ({ operations }) => { for (const { type } of operations) discarded.push(type); });
    const watcher = watchDroppedEdits(doc, (message) => notices.push(message));
    return {
      doc, notices, discarded, watcher,
      /** Renames as the page does: tracked, so a rename the server drops is reported. */
      rename(cardId: string, title: string) {
        const tracked = doc.track(() => renameCard(doc, cardId, title));
        watcher.follow(tracked.settled);
        return tracked;
      },
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
      /** Sends every unsent pending batch. */
      sendAll() {
        while (doc.checkpoint().pendingBatches.some(({ seq }) => seq > sent)) this.send();
      },
      /** Receives every commit it has not seen yet, in order. */
      receive() {
        for (const commit of log) {
          if (commit.serverSeq <= received) continue;
          doc.receive(commit);
          received = commit.serverSeq;
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
    assert.deepEqual([a.notices, b.notices], [[], []]);
  });

  it("drops a rename of a card another writer deleted, leaves no orphan data, and reports it on acknowledgement", async () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(deleteCard(a.doc, "seed-sketch"));
    const renamed = b.rename("seed-sketch", "Too late");
    assert.ok(renamed.value);
    a.send();
    b.receive();
    assert.deepEqual(b.notices, [], "nothing is reported before the server decides");
    assert.deepEqual(b.send().operations, []);
    a.receive(); b.receive();
    assert.equal((await renamed.settled)?.status, "rejected");
    assert.deepEqual([a.notices, b.notices], [[], ["Not saved: “Too late”. Another writer deleted this card."]]);
    for (const writer of [a, b]) {
      assert.equal(findCard(writer.doc, "seed-sketch"), undefined);
      assert.equal(writer.doc.state.titles.has("seed-sketch"), false);
      assert.deepEqual(writer.board(), serverBoard(n.server));
    }
  });

  it("reports a column-only move of a deleted card, which only the transform shows", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(deleteCard(a.doc, "seed-tests"));
    // seed-tests already sits right before seed-drag in order: moving it to the top of doing changes only its column.
    assert.ok(moveCard(b.doc, "seed-tests", "doing", 0));
    assert.deepEqual(b.doc.checkpoint().pendingBatches[0]?.operations.map(({ type }) => type), ["map/set"]);
    a.send(); b.send();
    a.receive(); b.receive();
    assert.deepEqual([b.discarded, b.notices], [[], ["Not moved: another writer deleted that card."]]);
  });

  it("reports a lost rename restored from a checkpoint through settled(batch)", async () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(deleteCard(a.doc, "seed-tests"));
    renameCard(b.doc, "seed-tests", "Typed before the reload");
    a.send();
    // The page reloads: a new client from B's checkpoint follows each restored pending batch.
    const saved = decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(b.doc.checkpoint())));
    const restored = createClient(Board, { clientId: saved.clientId, checkpoint: saved, onBatch() {} });
    const notices: string[] = [];
    const watcher = watchDroppedEdits(restored, (message) => notices.push(message));
    const outcomes = restored.checkpoint().pendingBatches.map((batch) => restored.settled(batch));
    for (const settled of outcomes) watcher.follow(settled);
    for (const commit of [n.server.commitsSince(saved.snapshot.serverSeq)!, [n.server.receive(saved.pendingBatches[0]!).commit]].flat()) {
      restored.receive(commit);
    }
    await Promise.all(outcomes);
    assert.deepEqual(notices, ["Not saved: “Typed before the reload”. Another writer deleted this card."]);
    watcher.stop();
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
    assert.deepEqual(b.notices, ["Not moved: another writer deleted that card."], "transformed and discarded, reported once");
    for (const writer of [a, b]) {
      assert.equal(findCard(writer.doc, "seed-drag"), undefined);
      assert.equal(writer.doc.state.columns.has("seed-drag"), false);
      assert.deepEqual(writer.board(), serverBoard(n.server));
    }
  });

  it("reports a same-column move of a deleted card through discard alone, and nothing a writer cancels itself", async () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(deleteCard(a.doc, "seed-sketch"));
    assert.ok(moveCard(b.doc, "seed-sketch", "todo", 2)); // A List move only: seed-sketch is already in todo.
    const renamed = b.rename("seed-drag", "Cancelled rename");
    a.send();
    b.send();
    b.receive();
    assert.deepEqual(b.notices, ["Not moved: another writer deleted that card."]);
    b.notices.length = 0;
    const pending = b.doc.checkpoint().pendingBatches[0]!;
    await b.watcher.cancel(async () => { b.doc.receive(n.server.reject(pending).commit); });
    assert.equal((await renamed.settled)?.status, "rejected");
    assert.deepEqual(b.notices, [], "the writer's own cancellation is not reported");
    assert.equal(findCard(b.doc, "seed-drag")?.card.title, "Drag cards between columns");
    b.watcher.stop();
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

describe("Undo on the board", () => {
  it("undoes and redoes adding, moving, renaming and deleting cards through the policy", () => {
    const n = network(), a = n.writer(), b = n.writer();
    const history = createUndoManager(a.doc, { captureTimeout: 0 });
    const views = [a.columns()];
    const edits = [
      () => addCard(a.doc, "todo", "New card", "new-card"),
      () => moveCard(a.doc, "new-card", "done", 0),
      () => renameCard(a.doc, "new-card", "Renamed"),
      () => moveCard(a.doc, "seed-tests", "todo", 0),
      () => deleteCard(a.doc, "seed-drag"),
    ];
    for (const edit of edits) { edit(); views.push(a.columns()); }
    const titles = () => [findCard(a.doc, "new-card")?.card.title, findCard(a.doc, "seed-drag")?.card.title];
    assert.deepEqual(titles(), ["Renamed", undefined]);
    const sync = () => { a.sendAll(); a.receive(); b.receive(); };
    sync();
    for (let index = views.length - 1; index > 0; index--) {
      assert.equal(history.undo(), true);
      sync();
      assert.deepEqual(a.columns(), views[index - 1], `undo to ${index - 1}`);
      assert.deepEqual(b.board(), a.board());
    }
    assert.equal(findCard(a.doc, "seed-drag")?.card.title, "Drag cards between columns", "the deleted card and its title are back");
    assert.equal(findCard(a.doc, "new-card"), undefined);
    for (let index = 1; index < views.length; index++) {
      assert.equal(history.redo(), true);
      sync();
      assert.deepEqual(a.columns(), views[index], `redo to ${index}`);
    }
    assert.deepEqual(titles(), ["Renamed", undefined]);
    assert.deepEqual(a.board(), serverBoard(n.server));
  });

  it("leaves another writer's later rename and a deleted card alone", () => {
    const n = network(), a = n.writer(), b = n.writer();
    const history = createUndoManager(a.doc, { captureTimeout: 0 });
    renameCard(a.doc, "seed-tests", "Mine");
    renameCard(a.doc, "seed-ship", "Mine too");
    a.sendAll(); b.receive();
    renameCard(b.doc, "seed-ship", "Theirs");
    deleteCard(b.doc, "seed-tests");
    b.sendAll(); a.receive();
    assert.equal(history.undo(), false, "both renames were superseded");
    assert.equal(findCard(a.doc, "seed-ship")?.card.title, "Theirs");
    assert.equal(a.doc.state.titles.has("seed-tests"), false, "no orphan title");
  });
});

describe("Dropped edits", () => {
  it("names each card's dropped rename, with its last title, and dropped column change once, in batch order", () => {
    const dropped = [
      { type: "map/set", path: "titles", key: "x", value: "first" },
      { type: "map/set", path: "columns", key: "y", value: "done" },
      { type: "list/delete", path: "order", id: { bunchId: "b", counter: 0 } },
      { type: "map/set", path: "titles", key: "x", value: "last" },
      { type: "map/set", path: "columns", key: "y", value: "todo" },
      { type: "map/delete", path: "titles", key: "z" },
    ] as const;
    assert.deepEqual(droppedEdits(dropped), [{ kind: "rename", id: "x", title: "last" }, { kind: "move", id: "y" }]);
    assert.deepEqual(droppedEdits([]), []);
  });
});
