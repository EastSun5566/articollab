import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient, createServer, decodeClientCheckpoint, decodeServerCommit, defineDocument, list, map, value,
  type ClientBatch, type ClientDocument, type DocumentOperation, type MapChangeEvent, type MapCollection,
  type ServerCommit,
} from "../src/index.ts";

type Item = string | { readonly label: string };
const Board = defineDocument({ fields: map<Item>(), items: list<string>(), count: value(0) });
type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;
type Commit = ServerCommit<DocumentOperation<Shape>>;
type Doc = ClientDocument<Shape>;
const json = (input: unknown): unknown => JSON.parse(JSON.stringify(input));
const wire = (commit: Commit) => decodeServerCommit(Board, json(commit));

/** Applies every event to an independent Map and checks identity against the live collection. */
function mirror<T extends Item>(fields: MapCollection<T>) {
  const entries = new Map(fields);
  const events: MapChangeEvent<T>[] = [];
  const stop = fields.observe((event) => {
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.changes));
    assert.ok(event.changes.length > 0, "empty events are not delivered");
    let previousKey: string | undefined;
    for (const change of event.changes) {
      assert.ok(Object.isFrozen(change));
      if (previousKey !== undefined) assert.ok(previousKey < change.key, "changes are sorted by key, once each");
      previousKey = change.key;
      assert.ok(Object.is(change.previous, entries.get(change.key)), `previous value of ${change.key}`);
      if (change.type === "set") {
        assert.ok(!Object.is(change.value, change.previous), "a set changes the value");
        entries.set(change.key, change.value);
      } else {
        assert.ok(change.previous !== undefined, "a delete removes a present key");
        entries.delete(change.key);
      }
    }
    assert.equal(entries.size, fields.size);
    for (const [key, live] of fields) assert.ok(Object.is(entries.get(key), live), `identity of ${key}`);
    events.push(event);
  });
  return { entries, events, stop };
}

function setup() {
  let mode: "accept" | "reject" | "transform" = "accept";
  const upper = (item: Item): Item => typeof item === "string" ? item.toUpperCase() : { label: item.label.toUpperCase() };
  const server = createServer(Board, { resolve: ({ batch }) => mode === "reject" ? [] :
    mode === "transform" ? batch.operations.map((operation) =>
      operation.type === "map/set" ? { ...operation, value: upper(operation.value) } : operation) : batch.operations });
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
  return { server, client, catchUp, setMode(next: typeof mode) { mode = next; } };
}

describe("Map visible changes", () => {
  it("starts at the current view and reports sets, updates and deletes with previous values", () => {
    const net = setup();
    const { doc } = net.client();
    doc.state.fields.set("keep", "k");
    const view = mirror(doc.state.fields);
    assert.equal(view.events.length, 0, "no initial event");
    doc.transact(() => {
      doc.state.fields.set("b", "new");
      doc.state.fields.set("a", "x");
      doc.state.fields.set("keep", "updated");
    });
    assert.deepEqual(view.events.at(-1)!.changes, [
      { type: "set", key: "a", value: "x", previous: undefined },
      { type: "set", key: "b", value: "new", previous: undefined },
      { type: "set", key: "keep", value: "updated", previous: "k" },
    ]);
    doc.state.fields.delete("a");
    assert.deepEqual(view.events.at(-1)!.changes, [{ type: "delete", key: "a", previous: "x" }]);
    view.stop();
  });

  it("stays silent for same-value sets, absent deletes and changes that cancel out", () => {
    const net = setup();
    const { doc } = net.client();
    const shared = { label: "same" };
    doc.state.fields.set("a", shared);
    const view = mirror(doc.state.fields);
    doc.state.fields.set("a", shared);
    doc.state.fields.delete("missing");
    doc.transact(() => { doc.state.fields.set("t", "temp"); doc.state.fields.delete("t"); });
    doc.state.fields.clear();
    assert.deepEqual(view.events.map(({ changes }) => changes.map(({ type, key }) => `${type}:${key}`)), [["delete:a"]]);
  });

  it("reports a decoded own acknowledgement's reference swap as a set, and an exact one as nothing", () => {
    const net = setup();
    const a = net.client();
    const view = mirror(a.doc.state.fields);
    a.doc.state.fields.set("plain", "text");
    a.doc.state.fields.set("object", { label: "o" });
    net.catchUp(a.doc);
    net.server.receive(a.batches.shift()!);
    net.server.receive(a.batches.shift()!);
    const before = view.events.length;
    net.catchUp(a.doc);
    assert.deepEqual(view.events.slice(before).flatMap(({ changes }) => changes.map(({ type, key }) => `${type}:${key}`)),
      ["set:object"], "a string is equal by Object.is; a decoded object is a new reference");
  });

  it("reports a peer's change and falls back to a full comparison after rejection or transformation", () => {
    const net = setup();
    const a = net.client(), b = net.client();
    const view = mirror(a.doc.state.fields);
    b.doc.state.fields.set("peer", "p");
    net.server.receive(b.batches.shift()!);
    net.catchUp(a.doc);
    assert.deepEqual(view.events.at(-1)!.changes, [{ type: "set", key: "peer", value: "p", previous: undefined }]);

    a.doc.state.fields.set("mine", "m");
    net.setMode("reject");
    net.server.receive(a.batches.shift()!);
    net.catchUp(a.doc);
    assert.deepEqual(view.events.at(-1)!.changes, [{ type: "delete", key: "mine", previous: "m" }]);

    a.doc.state.fields.set("mine", "m");
    net.setMode("transform");
    net.server.receive(a.batches.shift()!);
    net.catchUp(a.doc);
    assert.deepEqual(view.events.at(-1)!.changes, [{ type: "set", key: "mine", value: "M", previous: "m" }]);
  });

  it("delivers Map and List observers for one batch, and refuses to subscribe in a transaction", () => {
    const net = setup();
    const { doc } = net.client();
    const order: string[] = [];
    doc.state.fields.observe(() => order.push("fields"));
    doc.state.items.observe(() => order.push("items"));
    doc.transact(() => { doc.state.items.push("x"); doc.state.fields.set("k", "v"); });
    assert.deepEqual(order.toSorted(), ["fields", "items"]);
    assert.throws(() => doc.transact(() => doc.state.fields.observe(() => {})), /Cannot observe Map during a transaction/);
  });

  for (const seed of [1, 42, 2026]) it(`keeps independent mirrors correct under interleaving seed=${seed}`, () => {
    const net = setup();
    const clients = [net.client(), net.client(), net.client()];
    const views = clients.map(({ doc }) => mirror(doc.state.fields));
    let state = seed;
    const random = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
    const key = () => ["a", "b", "c", "d", "__proto__"][random(5)]!;
    const item = (): Item => random(3) === 0 ? { label: `o${random(5)}` } : ["x", "y", "z"][random(3)]!;
    for (let step = 0; step < 200; step++) {
      const index = random(clients.length), target = clients[index]!, action = random(6);
      try {
        if (action < 2 && target.doc.replayConflict === null) {
          const fields = target.doc.state.fields;
          target.doc.transact(() => {
            for (let edits = random(3) + 1; edits > 0; edits--) {
              const choice = random(5);
              if (choice === 0) fields.delete(key());
              else if (choice === 1 && random(4) === 0) fields.clear();
              else fields.set(key(), item());
            }
          });
        } else if (action === 2) net.catchUp(target.doc);
        else if (action === 3) {
          net.catchUp(target.doc);
          const batch = target.doc.checkpoint().pendingBatches[0];
          if (batch !== undefined) {
            net.setMode((["accept", "reject", "transform"] as const)[random(3)]!);
            net.server.receive(batch);
          }
        } else if (action === 4) {
          const saved = decodeClientCheckpoint(Board, json(target.doc.checkpoint()));
          views[index]!.stop();
          target.doc = createClient(Board, { clientId: saved.clientId, checkpoint: saved, onBatch() {} });
          views[index] = mirror(target.doc.state.fields);
        } else target.doc.state.count.value = step;
        // A missed notification would leave a stale mirror even when no event fires.
        for (const [i, client] of clients.entries()) {
          const live = client.doc.state.fields;
          assert.equal(views[i]!.entries.size, live.size, `client ${i} size`);
          for (const [k, v] of live) assert.ok(Object.is(views[i]!.entries.get(k), v), `client ${i} key ${k}`);
        }
      } catch (cause) { throw new Error(`seed=${seed}, step=${step}, client=${index}, action=${action}`, { cause }); }
    }
    net.setMode("accept");
    for (const target of clients) {
      net.catchUp(target.doc);
      while (target.doc.checkpoint().pendingBatches.length > 0) {
        net.server.receive(target.doc.checkpoint().pendingBatches[0]!);
        net.catchUp(target.doc);
      }
    }
    for (const target of clients) net.catchUp(target.doc);
    const expected = net.server.snapshot().data.fields;
    for (const [i, target] of clients.entries()) {
      assert.deepEqual(target.doc.state.fields.toObject(), expected);
      assert.deepEqual(Object.fromEntries(views[i]!.entries), expected);
    }
  });
});
