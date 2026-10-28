import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient, createServer, decodeClientCheckpoint, decodeCursor, decodeServerCommit,
  defineDocument, list, text, WireDecodeError,
  type ClientBatch, type ClientDocument, type Cursor, type DocumentOperation, type ServerCommit,
} from "../src/index.ts";
import type { RuntimeList, SavedIdRange } from "../src/list.ts";

const Board = defineDocument({ items: list<string>(), body: text(), title: text() });
type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;
type Commit = ServerCommit<DocumentOperation<Shape>>;
type Doc = ClientDocument<Shape>;
const json = (input: unknown): unknown => JSON.parse(JSON.stringify(input));
const wire = (commit: Commit) => decodeServerCommit(Board, json(commit));

function setup() {
  let mode: "accept" | "reject" | "transform" = "accept";
  const server = createServer(Board, { resolve: ({ batch }) => mode === "reject" ? [] :
    mode === "transform" ? batch.operations.map((operation) =>
      operation.type === "list/insert" || operation.type === "list/set"
        ? { ...operation, value: operation.value.toUpperCase() } : operation) : batch.operations });
  const client = () => {
    const batches: Batch[] = [];
    const doc = createClient(Board, { clientId: server.openClient(), onBatch(batch) { batches.push(batch); } });
    return { doc, batches };
  };
  const catchUp = (doc: Doc) => {
    const commits = server.commitsSince(doc.checkpoint().snapshot.serverSeq);
    assert.notEqual(commits, null);
    for (const commit of commits!) doc.receive(wire(commit));
  };
  /** Commits every pending batch of `writer`, then brings all `readers` up to date. */
  const sync = (writer: { batches: Batch[] }, ...readers: Doc[]) => {
    for (const batch of writer.batches.splice(0)) server.receive(batch);
    for (const doc of readers) catchUp(doc);
  };
  return { server, client, catchUp, sync, setMode(next: typeof mode) { mode = next; } };
}

/**
 * Independent oracle: expands the saved known-ID order, tombstones included, and counts present
 * elements before the anchor instead of asking articulated for cursor positions.
 */
function expectedIndex(ranges: readonly SavedIdRange[], cursor: Cursor): number | undefined {
  const known: { bunchId: string; counter: number; present: boolean }[] = [];
  for (const range of ranges) {
    for (let offset = 0; offset < range.count; offset++) {
      known.push({ bunchId: range.bunchId, counter: range.startCounter + offset, present: !range.isDeleted });
    }
  }
  const length = known.filter((id) => id.present).length;
  if (cursor.anchor === null) return cursor.bind === "left" ? 0 : length;
  const { bunchId, counter } = cursor.anchor;
  const position = known.findIndex((id) => id.bunchId === bunchId && id.counter === counter);
  if (position === -1) return undefined;
  const before = known.slice(0, position).filter((id) => id.present).length;
  return cursor.bind === "left" && known[position]!.present ? before + 1 : before;
}

describe("Cursors", () => {
  it("round-trips every gap of Text and List for both binds with frozen copies", () => {
    const { doc } = setup().client();
    doc.state.body.insert(0, "a😀bc");
    for (const item of ["w", "x", "y", "z"]) doc.state.items.push(item);
    for (const collection of [doc.state.body, doc.state.items]) {
      for (let index = 0; index <= collection.length; index++) {
        for (const bind of ["left", "right"] as const) {
          const cursor = collection.cursorAt(index, bind);
          assert.equal(cursor.bind, bind);
          assert.ok(Object.isFrozen(cursor));
          if (cursor.anchor !== null) assert.ok(Object.isFrozen(cursor.anchor));
          assert.equal(collection.cursorIndex(cursor), index, `${bind} ${index}`);
        }
      }
    }
    assert.equal(doc.state.body.cursorAt(0).anchor, null);
    assert.equal(doc.state.body.cursorAt(0).bind, "left");
    assert.equal(doc.state.body.cursorAt(doc.state.body.length, "right").anchor, null);
    // Text indices count elements, so the emoji is one gap wide.
    assert.equal(doc.state.body.length, 4);
  });

  it("keeps left cursors before and right cursors after concurrent inserts in their gap", () => {
    const net = setup();
    const a = net.client(), b = net.client();
    a.doc.state.body.insert(0, "abcd");
    net.sync(a, a.doc, b.doc);
    const left = a.doc.state.body.cursorAt(2), right = a.doc.state.body.cursorAt(2, "right");
    b.doc.state.body.insert(2, "XY");
    net.sync(b, a.doc, b.doc);
    assert.equal(a.doc.state.body.toString(), "abXYcd");
    assert.equal(a.doc.state.body.cursorIndex(left), 2);
    assert.equal(a.doc.state.body.cursorIndex(right), 4);
    b.doc.state.body.insert(0, "__");
    net.sync(b, a.doc);
    assert.equal(a.doc.state.body.cursorIndex(left), 4);
    assert.equal(a.doc.state.body.cursorIndex(right), 6);
  });

  it("moves to the nearest surviving gap when anchors are deleted", () => {
    const net = setup();
    const a = net.client(), b = net.client();
    for (const item of ["a", "b", "c", "d", "e"]) a.doc.state.items.push(item);
    net.sync(a, a.doc, b.doc);
    const items = a.doc.state.items;
    const left = items.cursorAt(3), right = items.cursorAt(3, "right");
    const start = items.cursorAt(0), end = items.cursorAt(5, "right");
    b.doc.state.items.delete(2); b.doc.state.items.delete(2);
    net.sync(b, a.doc);
    assert.deepEqual(items.toArray(), ["a", "b", "e"]);
    assert.equal(items.cursorIndex(left), 2);
    assert.equal(items.cursorIndex(right), 2);
    while (b.doc.state.items.length > 0) b.doc.state.items.delete(0);
    net.sync(b, a.doc);
    for (const cursor of [left, right, start, end]) assert.equal(items.cursorIndex(cursor), 0);
  });

  it("resolves unknown anchors to undefined until their insert arrives", () => {
    const net = setup();
    const a = net.client(), b = net.client();
    b.doc.state.body.insert(0, "hi");
    const remote = json(b.doc.state.body.cursorAt(2));
    const cursor = decodeCursor(remote);
    assert.equal(a.doc.state.body.cursorIndex(cursor), undefined);
    net.sync(b, a.doc);
    assert.equal(a.doc.state.body.cursorIndex(cursor), 2);
  });

  it("resolves an anchor from a rejected or rolled-back insert to undefined", () => {
    const net = setup();
    const writer = net.client();
    writer.doc.state.items.push("kept");
    net.sync(writer, writer.doc);
    writer.doc.state.items.push("dropped");
    const cursor = writer.doc.state.items.cursorAt(2);
    assert.equal(writer.doc.state.items.cursorIndex(cursor), 2);
    net.setMode("reject");
    net.sync(writer, writer.doc);
    assert.deepEqual(writer.doc.state.items.toArray(), ["kept"]);
    assert.equal(writer.doc.state.items.cursorIndex(cursor), undefined);

    let inside: Cursor | undefined;
    assert.throws(() => writer.doc.transact(() => {
      writer.doc.state.items.push("draft");
      inside = writer.doc.state.items.cursorAt(2);
      assert.equal(writer.doc.state.items.cursorIndex(inside), 2);
      throw new Error("abort");
    }), /abort/);
    assert.equal(writer.doc.state.items.cursorIndex(inside!), undefined);
    assert.equal(writer.batches.length, 0, "reads never emit batches");
  });

  it("keeps cursors scoped to one collection except for null anchors", () => {
    const { doc } = setup().client();
    doc.state.body.insert(0, "body");
    doc.state.title.insert(0, "title");
    doc.state.items.push("item");
    const inBody = doc.state.body.cursorAt(2);
    assert.equal(doc.state.title.cursorIndex(inBody), undefined);
    assert.equal(doc.state.items.cursorIndex(inBody), undefined);
    assert.equal(doc.state.title.cursorIndex(doc.state.body.cursorAt(0)), 0);
    assert.equal(doc.state.title.cursorIndex(doc.state.body.cursorAt(4, "right")), 5);
  });

  it("resolves tombstone anchors after snapshot loads and checkpoint restores", () => {
    const net = setup();
    const a = net.client();
    a.doc.state.body.insert(0, "abcdef");
    net.sync(a, a.doc);
    const left = a.doc.state.body.cursorAt(3), right = a.doc.state.body.cursorAt(3, "right");
    a.doc.state.body.delete(1, 4);
    net.sync(a, a.doc);
    const late = createClient(Board, { clientId: net.server.openClient(), snapshot: net.server.snapshot(), onBatch() {} });
    const saved = decodeClientCheckpoint(Board, json(a.doc.checkpoint()));
    const restored = createClient(Board, { clientId: saved.clientId, checkpoint: saved, onBatch() {} });
    for (const doc of [a.doc, late, restored]) {
      assert.equal(doc.state.body.toString(), "af");
      assert.equal(doc.state.body.cursorIndex(left), 1);
      assert.equal(doc.state.body.cursorIndex(decodeCursor(json(right))), 1);
    }
  });

  it("decodes only exact cursor JSON", () => {
    const anchor = { bunchId: "b", counter: 3 };
    const decoded = decodeCursor({ anchor, bind: "right" });
    assert.deepEqual(decoded, { anchor, bind: "right" });
    assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.anchor));
    assert.notEqual(decoded.anchor, anchor);
    assert.deepEqual(decodeCursor({ anchor: null, bind: "left" }), { anchor: null, bind: "left" });
    const invalid: [unknown, string][] = [
      [null, "/"], [[], "/"], [{ bind: "left" }, "/anchor"], [{ anchor: null }, "/bind"],
      [{ anchor: null, bind: "left", extra: 1 }, "/extra"], [{ anchor: null, bind: "middle" }, "/bind"],
      [{ anchor: null, bind: 1 }, "/bind"], [{ anchor: { bunchId: "", counter: 0 }, bind: "left" }, "/anchor/bunchId"],
      [{ anchor: { bunchId: "b", counter: -1 }, bind: "left" }, "/anchor/counter"],
      [{ anchor: { bunchId: "b", counter: 1.5 }, bind: "left" }, "/anchor/counter"],
      [{ anchor: { bunchId: "b", counter: 0, seq: 1 }, bind: "left" }, "/anchor/seq"],
    ];
    for (const [input, path] of invalid) {
      assert.throws(() => decodeCursor(input), (error: unknown) =>
        error instanceof WireDecodeError && error.path === path, JSON.stringify(input));
    }
  });

  it("rejects invalid indices, binds and cursor shapes", () => {
    const { doc } = setup().client();
    doc.state.items.push("a");
    const items = doc.state.items;
    for (const index of [-1, 2, 0.5, Number.NaN]) assert.throws(() => items.cursorAt(index), /Index out of bounds/);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercises untyped JavaScript callers.
    assert.throws(() => items.cursorAt(0, "up" as "left"), /bind/);
    for (const cursor of [null, {}, { anchor: null, bind: "up" }, { bind: "left" },
      { anchor: { bunchId: "", counter: 0 }, bind: "left" }, { anchor: { bunchId: "b", counter: -1 }, bind: "left" }]) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercises untyped JavaScript callers.
      assert.throws(() => items.cursorIndex(cursor as Cursor), /Cursor/, JSON.stringify(cursor));
    }
  });

  for (const seed of [1, 42, 2026]) it(`matches a tombstone-order oracle under interleaving seed=${seed}`, () => {
    const net = setup();
    const clients = [net.client(), net.client(), net.client()];
    const cursors: Cursor[] = [];
    let state = seed;
    const random = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
    let resolved = 0, unknown = 0;
    for (let step = 0; step < 250; step++) {
      const index = random(clients.length), target = clients[index]!, action = random(6);
      try {
        const items = target.doc.state.items;
        if (action < 2 && target.doc.replayConflict === null) {
          target.doc.transact(() => {
            for (let edits = random(3) + 1; edits > 0; edits--) {
              const choice = random(3);
              if (choice === 0 && items.length > 0) items.delete(random(items.length));
              else if (choice === 1 && items.length > 0) items.set(random(items.length), "s");
              else items.insert(random(items.length + 1), "i");
            }
          });
        } else if (action === 2) net.catchUp(target.doc);
        else if (action === 3) {
          net.catchUp(target.doc);
          const batch = target.doc.checkpoint().pendingBatches[0];
          if (batch !== undefined) {
            net.setMode((["accept", "reject", "transform"] as const)[random(3)]!);
            if (target.doc.replayConflict !== null) net.server.reject(batch);
            else net.server.receive(batch);
          }
        } else if (action === 4) {
          const saved = decodeClientCheckpoint(Board, json(target.doc.checkpoint()));
          target.doc = createClient(Board, { clientId: saved.clientId, checkpoint: saved, onBatch() {} });
        }
        if (cursors.length < 24 || random(4) === 0) {
          const cursor = decodeCursor(json(items.cursorAt(random(items.length + 1), random(2) === 0 ? "left" : "right")));
          cursors.splice(random(cursors.length + 1), cursors.length < 24 ? 0 : 1, cursor);
        }
        for (const [i, client] of clients.entries()) {
          const live = client.doc.state.items;
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Reads the internal optimistic state for the oracle.
          const ranges = (live as RuntimeList<string>).state.save().idList;
          for (const cursor of cursors) {
            const expected = expectedIndex(ranges, cursor);
            assert.equal(live.cursorIndex(cursor), expected, `client ${i} ${JSON.stringify(cursor)}`);
            if (expected === undefined) unknown++; else resolved++;
          }
        }
      } catch (cause) { throw new Error(`seed=${seed}, step=${step}, client=${index}, action=${action}`, { cause }); }
    }
    assert.ok(resolved > 1000 && unknown > 50, `resolved=${resolved}, unknown=${unknown}`);
  });
});
