import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { counterMap, createClient, createUndoManager, decodeClientBatch, decodeClientCheckpoint, defineDocument, list, map, PayloadValidationError, type DocumentOperation, type ServerCommit, type ServerDocument } from "articollab";
import {
  addCard, Board, cardsIn, COLUMNS, deleteCard, describeDropped, findCard, moveCard, onDroppedEdits, renameCard, voteCard, type Shape,
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
    // As the page does: notices from document events, except for edits this writer cancels itself.
    let cancelling = false;
    const stop = onDroppedEdits(doc, (message) => { if (!cancelling) notices.push(message); });
    return {
      doc, notices, discarded, stop,
      /** Renames, tracked so a test can also check the outcome. */
      rename: (cardId: string, title: string) => doc.track(() => renameCard(doc, cardId, title)),
      /** Votes, tracked so a test can also check the outcome. */
      vote: (cardId: string, delta: 1 | -1 = 1) => doc.track(() => voteCard(doc, cardId, delta)),
      /** Runs this writer's own cancellation, as the page's Discard button does. */
      async cancel(work: () => Promise<void>) {
        cancelling = true;
        try { await work(); } finally { cancelling = false; }
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

  it("reports a lost rename restored from a checkpoint, through the same events", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(deleteCard(a.doc, "seed-tests"));
    renameCard(b.doc, "seed-tests", "Typed before the reload");
    a.send();
    // The page reloads: a new client from B's checkpoint listens as before; nothing follows each batch.
    const saved = decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(b.doc.checkpoint())));
    const restored = createClient(Board, { clientId: saved.clientId, checkpoint: saved, onBatch() {} });
    const notices: string[] = [];
    const stop = onDroppedEdits(restored, (message) => notices.push(message));
    for (const commit of [n.server.commitsSince(saved.snapshot.serverSeq)!, [n.server.receive(saved.pendingBatches[0]!).commit]].flat()) {
      restored.receive(commit);
    }
    assert.deepEqual(notices, ["Not saved: “Typed before the reload”. Another writer deleted this card."]);
    stop();
  });

  it("reports a rename an undo wrote back after another writer deleted the card", () => {
    const n = network(), a = n.writer(), b = n.writer();
    const history = createUndoManager(a.doc, { captureTimeout: 0 });
    const before = findCard(a.doc, "seed-tests")?.card.title;
    assert.ok(renameCard(a.doc, "seed-tests", "Renamed"));
    a.sendAll(); a.receive(); b.receive();
    assert.ok(deleteCard(b.doc, "seed-tests"));
    b.sendAll();
    assert.ok(history.undo(), "the undo writes the old title back before A hears of the delete");
    a.sendAll(); a.receive();
    assert.deepEqual(a.notices, [`Not saved: “${before}”. Another writer deleted this card.`]);
    assert.equal(findCard(a.doc, "seed-tests"), undefined);
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
    await b.cancel(async () => { b.doc.receive(n.server.reject(pending).commit); });
    assert.equal((await renamed.settled)?.status, "rejected");
    assert.deepEqual(b.notices, [], "the writer's own cancellation is not reported");
    assert.equal(findCard(b.doc, "seed-drag")?.card.title, "Drag cards between columns");
    b.stop();
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

describe("Board payload schemas", () => {
  it("rejects a bad column or title locally, and on the server from a writer that skips the check", () => {
    const n = network(), a = n.writer();
    assert.throws(() => a.doc.state.columns.set("seed-ship", "trash" as never), PayloadValidationError); // oxlint-disable-line typescript/no-unsafe-type-assertion -- Writes an invalid column on purpose.
    assert.throws(() => a.doc.state.titles.set("seed-ship", " padded "), /without surrounding spaces/);
    assert.throws(() => a.doc.state.titles.set("seed-ship", "x".repeat(201)), PayloadValidationError);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, [], "nothing was recorded");
    // A writer without the schemas sends the same edit; the server refuses it before the policy runs.
    const Unchecked = defineDocument({ order: list<string>(), columns: map<string>(), titles: map<string>(), votes: counterMap() });
    const rogue = createClient(Unchecked, { clientId: n.server.openClient(), snapshot: n.server.snapshot(), onBatch() {} });
    rogue.state.columns.set("seed-ship", "trash");
    const batch = decodeClientBatch(Board, JSON.parse(JSON.stringify(rogue.checkpoint().pendingBatches[0])));
    const before = n.server.snapshot();
    assert.throws(() => n.server.receive(batch), (error) => error instanceof PayloadValidationError &&
      error.message === "Invalid payload at /columns/seed-ship: A column is one of todo, doing, done");
    assert.deepEqual(n.server.snapshot(), before);
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
  it("tells each card's dropped rename, with its last title, and a dropped move once, in batch order", () => {
    const dropped = [
      { type: "map/set", path: "titles", key: "x", value: "first" },
      { type: "map/set", path: "columns", key: "y", value: "done" },
      { type: "list/delete", path: "order", id: { bunchId: "b", counter: 0 } },
      { type: "map/set", path: "titles", key: "x", value: "last" },
      { type: "map/set", path: "columns", key: "y", value: "todo" },
      { type: "map/delete", path: "titles", key: "z" },
    ] as const;
    assert.deepEqual(describeDropped(dropped), [
      "Not saved: “last”. Another writer deleted this card.", "Not moved: another writer deleted that card.",
    ]);
    assert.deepEqual(describeDropped([]), []);
  });
});

describe("Votes on the board", () => {
  it("counts every concurrent vote, where a Map of numbers would keep only the last", async () => {
    const n = network(), a = n.writer(), b = n.writer();
    a.vote("seed-ship"); a.vote("seed-ship");
    b.vote("seed-ship");
    assert.equal(b.doc.state.votes.get("seed-ship"), 1, "each writer sees its own votes at once");
    a.sendAll(); b.sendAll();
    a.receive(); b.receive();
    assert.deepEqual([a.doc.state.votes.get("seed-ship"), b.doc.state.votes.get("seed-ship")], [3, 3]);
    assert.deepEqual(n.server.snapshot().data.votes, { "seed-ship": 3 });
    await Promise.resolve();
    assert.deepEqual([a.notices, b.notices], [[], []]);
  });

  it("drops a vote for a card another writer deleted first, and tells the voter", async () => {
    const n = network(), a = n.writer(), b = n.writer();
    a.vote("seed-ship");
    a.sendAll(); b.receive();
    assert.ok(deleteCard(b.doc, "seed-ship"));
    const late = a.vote("seed-ship");
    assert.equal(voteCard(a.doc, "missing"), false, "a card this writer does not know gets no vote");
    b.sendAll(); a.sendAll();
    a.receive(); b.receive();
    assert.equal((await late.settled)?.status, "rejected");
    assert.deepEqual(a.notices, ["Vote not counted: another writer deleted this card."]);
    assert.deepEqual(n.server.snapshot().data.votes, {}, "no votes remain for the deleted card");
    assert.deepEqual(describeDropped([{ type: "counterMap/add", path: "votes", key: "seed-ship", delta: 1 }]),
      ["Vote not counted: another writer deleted this card."]);
  });

  it("undoes only this writer's vote, and undoing a delete brings the card's votes back", () => {
    const n = network(), a = n.writer(), b = n.writer();
    const history = createUndoManager(a.doc, { captureTimeout: 0 });
    a.vote("seed-ship");
    b.vote("seed-ship"); b.vote("seed-ship");
    b.sendAll(); a.receive();
    assert.equal(a.doc.state.votes.get("seed-ship"), 3);
    assert.ok(history.undo());
    assert.equal(a.doc.state.votes.get("seed-ship"), 2, "B's votes stay");
    assert.ok(history.redo());
    a.sendAll(); b.receive();
    assert.equal(b.doc.state.votes.get("seed-ship"), 3);

    deleteCard(a.doc, "seed-ship");
    a.sendAll(); b.receive();
    assert.equal(b.doc.state.votes.get("seed-ship"), 0);
    assert.ok(history.undo());
    a.sendAll(); b.receive();
    assert.deepEqual([findCard(b.doc, "seed-ship")?.card.title, b.doc.state.votes.get("seed-ship")], ["Ship articollab 0.7", 3],
      "the policy accepts the votes because the same batch adds the card back");
  });
});
