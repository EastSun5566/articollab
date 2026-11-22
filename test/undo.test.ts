import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  createClient, createServer, createUndoManager, decodeServerCommit, defineDocument, list, map, text, value,
  type ClientBatch, type ClientDocument, type DocumentOperation, type ServerCommit, type UndoManager,
} from "../src/index.ts";

const Doc = defineDocument({ count: value(0), items: list<string>(), body: text(), tags: map<string>() });
type Shape = typeof Doc.definition;
type Operation = DocumentOperation<Shape>;
type Batch = ClientBatch<Operation>;
type Commit = ServerCommit<Operation>;
const json = (input: unknown): unknown => JSON.parse(JSON.stringify(input));
const view = (doc: ClientDocument<Shape>) => JSON.stringify([doc.state.count.value, doc.state.items.toArray(),
  doc.state.body.toString(), doc.state.tags.toObject()]);

function setup(resolve?: (batch: Batch) => readonly Operation[]) {
  const server = createServer(Doc, resolve === undefined ? {} : { resolve: ({ batch }) => resolve(batch) });
  const log: Commit[] = [];
  const writer = (options: { captureTimeout?: number; paths?: string[] } = {}) => {
    const batches: Batch[] = [];
    const doc = createClient(Doc, { clientId: server.openClient(), snapshot: server.snapshot(), onBatch(batch) { batches.push(batch); } });
    let received = server.snapshot().serverSeq;
    const history = createUndoManager(doc, { captureTimeout: 0, ...options });
    return {
      doc, history, batches,
      /** Sends every pending batch, as the sync engine would. */
      send() { for (const batch of batches.splice(0)) log.push(server.receive(batch).commit); },
      /** Receives every commit it has not seen, decoded as over the wire. */
      receive() {
        for (const commit of log) {
          if (commit.serverSeq <= received) continue;
          doc.receive(decodeServerCommit(Doc, json(commit)));
          received = commit.serverSeq;
        }
      },
    };
  };
  return { server, writer };
}

describe("Undo manager", () => {
  it("undoes and redoes each kind of change, one transaction per step", () => {
    const { writer } = setup();
    const a = writer();
    const views = [view(a.doc)];
    const edits: (() => void)[] = [
      () => { a.doc.state.count.set(3); },
      () => { a.doc.transact(() => { for (const item of ["a", "b", "c", "d"]) a.doc.state.items.push(item); }); },
      () => { a.doc.state.items.move(0, 3); },
      () => { a.doc.state.items.set(1, "C"); },
      () => { a.doc.transact(() => { a.doc.state.items.delete(0); a.doc.state.items.delete(0); }); },
      () => { a.doc.state.body.insert(0, "hello world"); },
      () => { a.doc.state.body.delete(2, 6); },
      () => { a.doc.state.tags.set("x", "1"); },
      () => { a.doc.transact(() => { a.doc.state.tags.set("x", "2"); a.doc.state.tags.set("y", "3"); }); },
      () => { a.doc.state.tags.delete("x"); },
    ];
    for (const edit of edits) { edit(); views.push(view(a.doc)); }
    assert.deepEqual([a.history.canUndo, a.history.canRedo], [true, false]);
    for (let index = views.length - 1; index > 0; index--) {
      assert.equal(a.history.undo(), true);
      assert.equal(view(a.doc), views[index - 1], `undo back to step ${index - 1}`);
    }
    assert.deepEqual([a.history.undo(), a.history.canUndo, a.history.canRedo], [false, false, true]);
    for (let index = 1; index < views.length; index++) {
      assert.equal(a.history.redo(), true);
      assert.equal(view(a.doc), views[index], `redo to step ${index}`);
    }
    assert.equal(a.history.redo(), false);
    a.send(); a.receive();
    assert.equal(view(a.doc), views.at(-1));
  });

  it("reinserts deleted elements at their place and follows them through later steps", () => {
    const { writer, server } = setup();
    const a = writer();
    a.doc.transact(() => { for (const item of ["a", "b", "c"]) a.doc.state.items.push(item); });
    a.doc.state.body.insert(0, "abc");
    a.history.stopCapturing();
    a.doc.state.items.set(1, "B");
    a.doc.state.items.delete(1);
    a.doc.state.body.delete(1, 1);
    a.history.undo(); a.history.undo();
    assert.deepEqual([a.doc.state.items.toArray(), a.doc.state.body.toString()], [["a", "B", "c"], "abc"]);
    a.history.undo();
    assert.deepEqual(a.doc.state.items.toArray(), ["a", "b", "c"], "the set is undone on the reinserted element");
    a.history.undo(); a.history.undo();
    assert.deepEqual([a.doc.state.items.toArray(), a.doc.state.body.toString()], [[], ""], "the reinserted elements are removed");
    for (let index = 0; index < 5; index++) a.history.redo();
    assert.deepEqual([a.doc.state.items.toArray(), a.doc.state.body.toString()], [["a", "c"], "ac"]);
    a.send();
    assert.deepEqual(server.snapshot().data.items.values, ["a", "c"]);
  });

  it("skips what another writer changed since, and moves on to the next step that still applies", () => {
    const { writer } = setup();
    const a = writer(), b = writer();
    a.doc.transact(() => { a.doc.state.items.push("x"); a.doc.state.items.push("y"); a.doc.state.tags.set("k", "a"); });
    a.send(); a.receive(); b.receive();
    a.doc.state.count.set(1);
    a.doc.state.tags.set("k", "mine");
    a.doc.state.items.set(0, "X");
    a.doc.state.items.move(1, 0);
    a.send(); b.receive();
    b.doc.transact(() => {
      b.doc.state.tags.set("k", "theirs");
      b.doc.state.items.set(1, "theirs");
      b.doc.state.items.move(0, 1);
    });
    b.send(); a.receive();
    assert.deepEqual(a.doc.state.items.toArray(), ["theirs", "y"]);
    // The move, the set and the tag were all changed since: undo skips those steps and reverts the count.
    assert.equal(a.history.undo(), true);
    assert.equal(view(a.doc), JSON.stringify([0, ["theirs", "y"], "", { k: "theirs" }]));
    assert.equal(a.history.canUndo, true, "the first step still applies");
    // The first step inserted x and y and set the tag: both elements are still visible, so they go;
    // the tag was changed since, so it stays.
    assert.equal(a.history.undo(), true);
    assert.deepEqual([a.doc.state.items.toArray(), a.doc.state.tags.toObject()], [[], { k: "theirs" }]);
    assert.deepEqual([a.history.undo(), a.history.canUndo], [false, false]);
    // Steps that a peer's later change voided entirely are dropped on the way to one that applies.
    a.doc.state.count.set(7);
    a.doc.state.items.push("p");
    a.doc.state.items.set(0, "P");
    a.send(); b.receive();
    b.doc.state.items.delete(0); b.send(); a.receive();
    assert.equal(a.history.undo(), true);
    assert.deepEqual([a.doc.state.count.value, a.doc.state.items.toArray(), a.history.canUndo], [0, [], false]);
  });

  it("merges local changes within captureTimeout, until stopCapturing or an undo", () => {
    mock.timers.enable({ apis: ["Date"], now: 1000 });
    try {
      const { writer } = setup();
      const a = writer({ captureTimeout: 500 });
      a.doc.state.body.insert(0, "a");
      mock.timers.tick(400);
      a.doc.state.body.insert(1, "b");
      mock.timers.tick(499);
      a.doc.state.body.insert(2, "c");
      mock.timers.tick(500);
      a.doc.state.body.insert(3, "d");
      a.history.stopCapturing();
      a.doc.state.body.insert(4, "e");
      a.history.undo();
      a.doc.state.body.insert(4, "f");
      a.doc.state.body.insert(5, "g");
      assert.equal(a.doc.state.body.toString(), "abcdfg");
      assert.equal(a.history.canRedo, false, "a new change clears redo");
      const steps: string[] = [];
      while (a.history.undo()) steps.push(a.doc.state.body.toString());
      assert.deepEqual(steps, ["abcd", "abc", ""], "f and g merged; d alone; a, b and c merged");
    } finally {
      mock.timers.reset();
    }
  });

  it("records only its own tracked paths, and undoes through server transformations", () => {
    const { writer } = setup((batch) => batch.operations.map((operation) =>
      operation.type === "value/set" ? { ...operation, value: Math.min(operation.value, 10) } : operation));
    const a = writer({ paths: ["count", "items"] }), b = writer();
    a.doc.state.tags.set("ignored", "1");
    assert.equal(a.history.canUndo, false, "untracked paths are not recorded");
    b.doc.state.count.set(5); b.send(); a.receive();
    assert.equal(a.history.canUndo, false, "peers' changes are not recorded");
    a.doc.state.count.set(12);
    a.send(); a.receive();
    assert.equal(a.doc.state.count.value, 10, "the server clamped it");
    assert.equal(a.history.undo(), false, "the value is no longer what this writer set");
    assert.equal(a.doc.state.count.value, 10);
    assert.throws(() => createUndoManager(a.doc), /already has an undo manager/);
    assert.throws(() => createUndoManager(b.doc, { paths: ["nope"] }), /Unknown document path: nope/);
  });

  it("throws while blocked or inside a transaction, leaving its steps, and stops after destroy", () => {
    const { writer, server } = setup();
    const a = writer();
    const changes: number[] = [];
    const stop = a.history.on("change", () => changes.push(changes.length));
    a.doc.state.items.push("x");
    a.doc.state.items.set(0, "y");
    assert.throws(() => a.doc.transact(() => a.history.undo()), /inside a transaction/);
    // Reject the insertion: the pending set now targets an unknown element and blocks.
    a.doc.receive(server.reject(a.batches.shift()!).commit);
    assert.notEqual(a.doc.replayConflict, null);
    assert.throws(() => a.history.undo(), /blocked/);
    assert.equal(a.history.canUndo, true);
    assert.equal(changes.length, 2);
    stop();
    a.history.destroy();
    assert.throws(() => a.history.undo(), /destroyed/);
    const again: UndoManager = createUndoManager(a.doc);
    assert.equal(again.canUndo, false);
    again.destroy(); again.destroy();
  });

  it("returns to every earlier view for one writer under random edits, undos and redos", () => {
    for (let seed = 1; seed <= 30; seed++) {
      let state = seed;
      const random = () => { state = (state * 1103515245 + 12345) % 2 ** 31; return state / 2 ** 31; };
      const pick = (length: number) => Math.floor(random() * length);
      const { writer } = setup();
      const a = writer();
      const done = [view(a.doc)], undone: string[] = [];
      for (let round = 0; round < 60; round++) {
        const roll = random();
        if (roll < 0.15 && done.length > 1) {
          assert.equal(a.history.undo(), true);
          undone.push(done.pop()!);
          assert.equal(view(a.doc), done.at(-1), `seed ${seed} round ${round}: undo`);
        } else if (roll < 0.25 && undone.length > 0) {
          assert.equal(a.history.redo(), true);
          done.push(undone.pop()!);
          assert.equal(view(a.doc), done.at(-1), `seed ${seed} round ${round}: redo`);
        } else {
          let recorded = false;
          const stop = a.history.on("change", () => { recorded = true; });
          a.doc.transact(() => {
            for (let count = 1 + pick(3); count > 0; count--) randomEdit(a.doc, pick, random);
          });
          stop();
          // A batch that left the view unchanged with new IDs, such as retyping a deleted letter, is still a step.
          if (!recorded) { assert.equal(view(a.doc), done.at(-1), `seed ${seed} round ${round}: unrecorded change`); continue; }
          done.push(view(a.doc));
          undone.length = 0;
        }
        if (random() < 0.3) { a.send(); a.receive(); }
      }
    }
  });

  it("converges two writers that edit, undo and redo concurrently", () => {
    for (let seed = 1; seed <= 30; seed++) {
      let state = seed;
      const random = () => { state = (state * 1103515245 + 12345) % 2 ** 31; return state / 2 ** 31; };
      const pick = (length: number) => Math.floor(random() * length);
      const { writer, server } = setup();
      const writers = [writer(), writer()];
      for (let round = 0; round < 80; round++) {
        const w = writers[pick(2)]!;
        const roll = random();
        if (roll < 0.2) w.history.undo();
        else if (roll < 0.3) w.history.redo();
        else w.doc.transact(() => { randomEdit(w.doc, pick, random); });
        if (random() < 0.4) w.send();
        if (random() < 0.4) w.receive();
      }
      for (const w of writers) w.send();
      for (const w of writers) w.receive();
      const { data } = server.snapshot();
      const expected = JSON.stringify([data.count, data.items.values, data.body.value, data.tags]);
      for (const w of writers) assert.equal(view(w.doc), expected, `seed ${seed}`);
    }
  });
});

function randomEdit(doc: ClientDocument<Shape>, pick: (length: number) => number, random: () => number): void {
  const { items, body, tags, count } = doc.state;
  switch (pick(8)) {
    case 0: count.set(pick(5)); break;
    case 1: items.insert(pick(items.length + 1), `i${pick(100)}`); break;
    case 2: if (items.length > 0) items.delete(pick(items.length)); break;
    case 3: if (items.length > 0) items.set(pick(items.length), `s${pick(100)}`); break;
    case 4: if (items.length > 1) items.move(pick(items.length), pick(items.length)); break;
    case 5: body.insert(pick(body.length + 1), random() < 0.2 ? "😀" : "xyz".slice(0, 1 + pick(3))); break;
    case 6: if (body.length > 0) { const at = pick(body.length); body.delete(at, 1 + pick(Math.min(3, body.length - at))); } break;
    default: if (random() < 0.5) tags.set(`k${pick(3)}`, `v${pick(10)}`); else tags.delete(`k${pick(3)}`);
  }
}
