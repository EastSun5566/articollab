import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  createClient, createServer, decodeClientCheckpoint, decodeServerCommit,
  defineDocument, list, text, value,
  type ClientBatch, type ClientDocument, type DocumentOperation, type List, type ListChangeEvent,
  type ServerCommit,
} from "../src/index.ts";
import { ListState, RuntimeList } from "../src/list.ts";

type Item = string | { readonly label: string };
const Board = defineDocument({ items: list<Item>(), other: list<string>(), body: text(), count: value(0) });
type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;
type Commit = ServerCommit<DocumentOperation<Shape>>;
type Doc = ClientDocument<Shape>;
const json = (input: unknown): unknown => JSON.parse(JSON.stringify(input));
const wire = (commit: Commit) => decodeServerCommit(Board, json(commit));

/** Applies every event to an independent array and checks identity against the live List. */
function mirror<T extends Item>(items: List<T>, callback?: (event: ListChangeEvent<T>) => void) {
  let elements = [...items];
  const events: ListChangeEvent<T>[] = [];
  const stop = items.observe((event) => {
    assert.equal(event.beforeLength, elements.length);
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.changes));
    let previous: { index: number; type: string } | undefined;
    for (const change of event.changes) {
      assert.ok(Object.isFrozen(change));
      if (previous !== undefined) {
        assert.ok(change.index < previous.index ||
          (change.index === previous.index && previous.type === "set" && change.type === "splice"),
        "changes must be descending, with a set before a splice at the same index");
      }
      if (change.type === "set") {
        assert.ok(change.index >= 0 && change.index < elements.length);
        elements = elements.with(change.index, change.value);
      } else {
        assert.ok(Object.isFrozen(change.insert));
        assert.ok(change.index >= 0 && change.index + change.deleteCount <= elements.length);
        assert.ok(change.deleteCount > 0 || change.insert.length > 0);
        elements = elements.toSpliced(change.index, change.deleteCount, ...change.insert);
      }
      previous = change;
    }
    assert.equal(event.afterLength, elements.length);
    assert.equal(elements.length, items.length);
    elements.forEach((element, index) => assert.ok(Object.is(element, items.get(index)), `identity at ${index}`));
    events.push(event);
    callback?.(event);
  });
  return { get elements() { return elements; }, events, stop };
}

function setup() {
  let mode: "accept" | "reject" | "transform" = "accept";
  const upper = (item: Item): Item => typeof item === "string" ? item.toUpperCase() : { label: item.label.toUpperCase() };
  const server = createServer(Board, { resolve: ({ batch }) => mode === "reject" ? [] :
    mode === "transform" ? batch.operations.map((operation) =>
      (operation.type === "list/insert" || operation.type === "list/set") && operation.path === "items"
        ? { ...operation, value: upper(operation.value) } : operation) : batch.operations });
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

describe("List visible changes", () => {
  it("starts at the current view and emits frozen splice and set changes in original coordinates", () => {
    const { doc } = setup().client();
    doc.state.items.push("a"); doc.state.items.push("b");
    const checkpoint = doc.checkpoint();
    const view = mirror(doc.state.items);
    assert.deepEqual(doc.checkpoint(), checkpoint);
    assert.equal(view.events.length, 0);
    doc.state.items.insert(1, "x");
    assert.deepEqual(view.events[0], { beforeLength: 2, afterLength: 3,
      changes: [{ type: "splice", index: 1, deleteCount: 0, insert: ["x"] }] });
    doc.state.items.set(0, "A");
    assert.deepEqual(view.events[1]?.changes, [{ type: "set", index: 0, value: "A" }]);
    doc.transact(() => { doc.state.items.delete(0); doc.state.items.push("z"); });
    assert.deepEqual(view.events[2]?.changes, [
      { type: "splice", index: 3, deleteCount: 0, insert: ["z"] },
      { type: "splice", index: 0, deleteCount: 1, insert: [] },
    ]);
    assert.deepEqual(view.elements, ["x", "b", "z"]);
    view.stop(); view.stop();
    doc.state.items.push("unobserved");
    assert.equal(view.events.length, 3);
  });

  it("orders a set before an insertion at the same pre-event index", () => {
    const { doc } = setup().client();
    doc.state.items.push("a"); doc.state.items.push("b");
    const view = mirror(doc.state.items);
    doc.transact(() => { doc.state.items.set(1, "B"); doc.state.items.insert(1, "x"); });
    assert.deepEqual(view.events[0]?.changes, [
      { type: "set", index: 1, value: "B" },
      { type: "splice", index: 1, deleteCount: 0, insert: ["x"] },
    ]);
    assert.deepEqual(view.elements, ["a", "x", "B"]);
  });

  it("stays silent for same-value sets, ID-only replacement and redistributed equal values", () => {
    const net = setup(), writer = net.client(), peer = net.client();
    writer.doc.transact(() => { for (const item of ["a", "a", "a", "b"]) writer.doc.state.items.push(item); });
    net.server.receive(writer.batches[0]!); net.catchUp(writer.doc); net.catchUp(peer.doc);
    const local = mirror(writer.doc.state.items), remote = mirror(peer.doc.state.items);
    writer.doc.state.items.set(3, "b");
    writer.doc.transact(() => { writer.doc.state.items.delete(3); writer.doc.state.items.insert(3, "b"); });
    writer.doc.transact(() => { writer.doc.state.items.delete(1); writer.doc.state.items.insert(0, "a"); });
    for (const batch of writer.batches.slice(1)) net.server.receive(batch);
    net.catchUp(writer.doc); net.catchUp(peer.doc);
    assert.equal(local.events.length, 0); assert.equal(remote.events.length, 0);
    assert.deepEqual(remote.elements, ["a", "a", "a", "b"]);
  });

  it("reports a delete-and-reinsert move as two targeted splices, not a full rewrite", () => {
    const net = setup(), writer = net.client(), peer = net.client();
    writer.doc.transact(() => { for (let index = 0; index < 10; index++) writer.doc.state.items.push(`c${index}`); });
    net.server.receive(writer.batches[0]!); net.catchUp(writer.doc); net.catchUp(peer.doc);
    const view = mirror(peer.doc.state.items);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Spies on the private fallback to prove the move stays targeted.
    const full = mock.method(ListState.prototype as unknown as { fullChangesTo(): unknown }, "fullChangesTo");
    try {
      writer.doc.transact(() => { writer.doc.state.items.delete(2); writer.doc.state.items.insert(7, "c2"); });
      net.server.receive(writer.batches[1]!); net.catchUp(peer.doc);
      assert.equal(full.mock.callCount(), 0);
    } finally { full.mock.restore(); }
    assert.deepEqual(view.events[0]?.changes, [
      { type: "splice", index: 8, deleteCount: 0, insert: ["c2"] },
      { type: "splice", index: 2, deleteCount: 1, insert: [] },
    ]);
    assert.deepEqual(view.elements, ["c0", "c1", "c3", "c4", "c5", "c6", "c7", "c2", "c8", "c9"]);
  });

  it("reports a decoded own acknowledgement's reference swap as a set", () => {
    const net = setup(), { doc, batches } = net.client();
    const payload = { label: "card" };
    doc.state.items.push("first"); doc.state.items.push(payload);
    const view = mirror(doc.state.items);
    const order: string[] = [];
    doc.on("change", ({ origin }) => order.push(origin));
    doc.receive(wire(net.server.receive(batches[0]!).commit));
    assert.equal(view.events.length, 0, "primitive values keep their identity");
    doc.receive(wire(net.server.receive(batches[1]!).commit));
    assert.deepEqual(order, ["server"]);
    assert.equal(view.events.length, 1);
    const change = view.events[0]!.changes[0]!;
    assert.equal(change.type, "set");
    assert.ok(change.type === "set" && !Object.is(change.value, payload) && Object.isFrozen(change.value));
    assert.deepEqual(change.value, payload);
  });

  it("compares replayed Lists with overlapping, masking and disjoint pending work", () => {
    for (const pending of ["disjoint", "insert", "set", "delete"] as const) {
      const net = setup(), writer = net.client(), peer = net.client();
      writer.doc.transact(() => { for (const item of ["a", "b", "c"]) writer.doc.state.items.push(item); });
      net.server.receive(writer.batches[0]!); net.catchUp(writer.doc); net.catchUp(peer.doc);
      const view = mirror(peer.doc.state.items);
      if (pending === "disjoint") peer.doc.state.count.value = 1;
      if (pending === "insert") peer.doc.state.items.push("p");
      if (pending === "set") peer.doc.state.items.set(1, "mine");
      if (pending === "delete") peer.doc.state.items.delete(1);
      const count = view.events.length, saved = peer.doc.checkpoint().pendingBatches;
      writer.doc.state.items.set(1, "theirs");
      net.server.receive(writer.batches[1]!); net.catchUp(writer.doc); net.catchUp(peer.doc);
      // A pending set or delete of the same element masks the remote update.
      const masked = pending === "set" || pending === "delete";
      assert.equal(view.events.length, count + (masked ? 0 : 1), pending);
      assert.equal(peer.doc.state.items.get(1), pending === "set" ? "mine" : pending === "delete" ? "c" : "theirs");
      assert.deepEqual(peer.doc.checkpoint().pendingBatches, saved);
    }
  });

  it("resolves a concurrent set and delete as a delete without phantom content", () => {
    const net = setup(), a = net.client(), b = net.client();
    a.doc.state.items.push("todo"); net.server.receive(a.batches[0]!); net.catchUp(a.doc); net.catchUp(b.doc);
    const viewA = mirror(a.doc.state.items), viewB = mirror(b.doc.state.items);
    a.doc.state.items.set(0, "edited");
    b.doc.state.items.delete(0);
    net.server.receive(b.batches[0]!); net.catchUp(a.doc); net.catchUp(b.doc);
    net.server.receive(a.batches[1]!); net.catchUp(a.doc); net.catchUp(b.doc);
    assert.deepEqual(viewA.elements, []); assert.deepEqual(viewB.elements, []);
    assert.equal(a.doc.replayConflict, null);
  });

  it("falls back for rejection, transformation and a blocked suffix", () => {
    const net = setup(), { doc, batches } = net.client(), view = mirror(doc.state.items);
    doc.state.items.push("a"); doc.state.items.set(0, "b");
    doc.receive(wire(net.server.reject(batches[0]!).commit));
    assert.deepEqual(view.elements, []);
    assert.equal(doc.replayConflict?.batch.seq, 2);
    doc.receive(wire(net.server.reject(batches[1]!).commit));
    assert.equal(doc.replayConflict, null);
    net.setMode("transform");
    doc.state.items.push("c"); doc.state.items.push({ label: "d" });
    doc.receive(wire(net.server.receive(batches[2]!).commit));
    doc.receive(wire(net.server.receive(batches[3]!).commit));
    assert.deepEqual(view.elements, ["C", { label: "D" }]);
  });

  it("keeps mirrors and silent acknowledgements correct after checkpoint restore", () => {
    const net = setup(), { doc, batches } = net.client();
    doc.state.items.push("a"); doc.state.items.push("b");
    doc.receive(wire(net.server.receive(batches[0]!).commit));
    const saved = decodeClientCheckpoint(Board, json(doc.checkpoint()));
    const restored = createClient(Board, { clientId: saved.clientId, checkpoint: saved, onBatch() {} });
    const view = mirror(restored.state.items);
    restored.receive(wire(net.server.receive(batches[1]!).commit));
    assert.equal(view.events.length, 0);
    assert.deepEqual(restored.checkpoint().pendingBatches, []);
  });

  it("groups mixed transactions, rolls back failure, and rejects subscription during a transaction", () => {
    const { doc, batches } = setup().client();
    const items = mirror(doc.state.items), other = mirror(doc.state.other), order: string[] = [];
    doc.on("change", () => order.push("change"));
    doc.state.items.observe(() => order.push("observe"));
    doc.transact(() => {
      doc.state.items.push("a");
      doc.transact(() => { doc.state.other.push("b"); doc.state.body.insert(0, "c"); });
      assert.equal(items.events.length, 0);
      assert.throws(() => doc.state.items.observe(() => {}), /Cannot observe List during a transaction/);
    });
    assert.equal(batches.length, 1);
    assert.deepEqual(order, ["change", "observe"]);
    assert.equal(items.events.length, 1); assert.equal(other.events.length, 1);
    const error = new Error("rollback");
    assert.throws(() => doc.transact(() => { doc.state.items.delete(0); throw error; }), (cause) => cause === error);
    assert.equal(items.events.length, 1);
    assert.deepEqual(items.elements, ["a"]);
  });

  it("delivers Text and List observers together after coalesced listener mutations", () => {
    const { doc } = setup().client();
    const items = mirror(doc.state.items);
    const body: string[] = [];
    doc.state.body.observe(({ changes }) => { for (const change of changes) body.splice(change.index, change.deleteCount, ...change.insert); });
    let nested = false;
    doc.on("change", () => {
      if (nested) return;
      nested = true;
      doc.state.items.push("b"); doc.state.body.insert(0, "t");
    });
    doc.state.items.push("a");
    assert.deepEqual(items.elements, ["a", "b"]);
    assert.equal(items.events.length, 1);
    assert.deepEqual(body, ["t"]);
  });

  it("retains baselines when onBatch or a legacy listener throws, then catches up", () => {
    const net = setup(), error = new Error("onBatch"), batches: Batch[] = [];
    let fail = true;
    const doc = createClient(Board, { clientId: net.server.openClient(), onBatch(batch) {
      batches.push(batch);
      if (fail) { fail = false; throw error; }
    } });
    const view = mirror(doc.state.items);
    assert.throws(() => doc.state.items.push("a"), (cause) => cause === error);
    assert.equal(view.events.length, 0);
    doc.receive(wire(net.server.receive(batches[0]!).commit));
    assert.deepEqual(view.elements, ["a"]);
    const writer = net.client(), listenerError = new Error("listener");
    const off = doc.on("change", () => { throw listenerError; });
    writer.doc.state.items.push("w");
    net.server.receive(writer.batches[0]!);
    assert.throws(() => net.catchUp(doc), (cause) => cause === listenerError);
    assert.equal(view.events.length, 1);
    off(); doc.state.count.value = 1;
    // The writer never caught up, so its push anchors at the start of the list.
    assert.deepEqual(view.elements, ["w", "a"]);
  });

  it("advances only invoked baselines when an observer throws, and drains reentrant observers", () => {
    const { doc } = setup().client(), error = new Error("observer");
    let calls = 0;
    const off = doc.state.items.observe(() => { calls++; throw error; });
    const view = mirror(doc.state.items);
    assert.throws(() => doc.state.items.push("a"), (cause) => cause === error);
    assert.equal(calls, 1); assert.equal(view.events.length, 0);
    off(); doc.state.count.value = 1;
    assert.deepEqual(view.elements, ["a"]);

    let depth = 0, maxDepth = 0;
    const first = mirror(doc.state.items, () => {
      depth++; maxDepth = Math.max(depth, maxDepth);
      if (doc.state.items.length === 2) doc.state.items.set(1, "B");
      depth--;
    });
    const second = mirror(doc.state.items);
    doc.state.items.push("b");
    assert.equal(maxDepth, 1);
    assert.equal(first.events.length, 2); assert.equal(second.events.length, 1);
    assert.deepEqual(second.elements, ["a", "B"]);
  });

  it("handles unsubscribe and new subscriptions during delivery without sending past changes", () => {
    const { doc } = setup().client();
    let stop = () => {}, late: ReturnType<typeof mirror<Item>> | undefined;
    doc.state.items.observe(() => { stop(); late ??= mirror(doc.state.items); });
    let removedCalls = 0;
    stop = doc.state.items.observe(() => { removedCalls++; });
    doc.state.items.push("a");
    assert.equal(removedCalls, 0); assert.equal(late?.events.length, 0);
    doc.state.items.push("b");
    assert.deepEqual(late?.elements, ["a", "b"]);
  });

  it("keeps invalid receives atomic and does not notify", () => {
    const net = setup(), writer = net.client(), peer = net.client(), view = mirror(peer.doc.state.items);
    writer.doc.state.items.push("a"); const commit = net.server.receive(writer.batches[0]!).commit;
    const before = peer.doc.checkpoint();
    assert.throws(() => peer.doc.receive({ ...commit, operations: [{ type: "list/set", path: "items",
      id: { bunchId: "unknown", counter: 0 }, value: "x" }] }));
    assert.deepEqual(peer.doc.checkpoint(), before); assert.equal(view.events.length, 0);
    peer.doc.receive(wire(commit));
    assert.deepEqual(view.elements, ["a"]);
  });

  it("does no diff work without subscribers and compares only affected IDs otherwise", () => {
    const net = setup(), writer = net.client(), peer = net.client();
    const diff = mock.method(ListState.prototype, "changesTo");
    const track = mock.method(RuntimeList.prototype, "track");
    try {
      writer.doc.state.items.push("a"); writer.doc.state.items.push("b");
      for (const batch of writer.batches) net.server.receive(batch);
      net.catchUp(writer.doc); net.catchUp(peer.doc);
      assert.equal(diff.mock.callCount(), 0);
      assert.equal(track.mock.callCount(), 0);
    } finally { diff.mock.restore(); track.mock.restore(); }
    const events: ListChangeEvent<Item>[] = [];
    const stop = peer.doc.state.items.observe((event) => { events.push(event); });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Spies on the private fallback to prove the targeted path is used.
    const full = mock.method(ListState.prototype as unknown as { fullChangesTo(): unknown }, "fullChangesTo");
    try {
      writer.doc.state.items.set(1, "B");
      net.server.receive(writer.batches[2]!); net.catchUp(peer.doc);
      assert.equal(full.mock.callCount(), 0);
    } finally { full.mock.restore(); stop(); }
    assert.deepEqual(events[0]?.changes, [{ type: "set", index: 1, value: "B" }]);
  });

  for (const seed of [1, 42, 2026]) it(`keeps independent mirrors correct under interleaving seed=${seed}`, () => {
    const net = setup();
    const clients = [net.client(), net.client(), net.client()];
    let views = clients.map(({ doc }) => mirror(doc.state.items));
    let state = seed;
    const random = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
    const item = (): Item => random(3) === 0 ? { label: `o${random(5)}` } : ["a", "b", "c"][random(3)]!;
    for (let step = 0; step < 200; step++) {
      const index = random(clients.length), target = clients[index]!, action = random(6);
      try {
        if (action < 2 && target.doc.replayConflict === null) {
          const items = target.doc.state.items;
          target.doc.transact(() => {
            for (let edits = random(3) + 1; edits > 0; edits--) {
              const choice = random(3);
              if (choice === 0 && items.length > 0) items.delete(random(items.length));
              else if (choice === 1 && items.length > 0) items.set(random(items.length), item());
              else items.insert(random(items.length + 1), item());
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
          views[index]!.stop();
          target.doc = createClient(Board, { clientId: saved.clientId, checkpoint: saved, onBatch() {} });
          views[index] = mirror(target.doc.state.items);
        } else if (target.doc.replayConflict === null) target.doc.state.count.value = step;
        // A missed notification would leave a stale mirror even when no event fires.
        for (const [i, client] of clients.entries()) {
          const live = client.doc.state.items;
          assert.equal(views[i]!.elements.length, live.length);
          views[i]!.elements.forEach((element, at) => assert.ok(Object.is(element, live.get(at)), `client ${i} at ${at}`));
        }
      } catch (cause) { throw new Error(`seed=${seed}, step=${step}, client=${index}, action=${action}`, { cause }); }
    }
    for (const target of clients) {
      net.catchUp(target.doc);
      while (target.doc.checkpoint().pendingBatches.length > 0) {
        const batch = target.doc.checkpoint().pendingBatches[0]!;
        if (target.doc.replayConflict !== null) net.server.reject(batch);
        else { net.setMode("accept"); net.server.receive(batch); }
        for (const client of clients) net.catchUp(client.doc);
      }
    }
    for (const target of clients) {
      assert.deepEqual([...target.doc.state.items], [...clients[0]!.doc.state.items]);
      assert.deepEqual(target.doc.checkpoint().pendingBatches, []);
    }
    views = [];
  });
});
