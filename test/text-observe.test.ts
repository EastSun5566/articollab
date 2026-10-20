import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  createClient, createServer, decodeClientCheckpoint, decodeServerCommit,
  defineDocument, list, text, value,
  type ClientBatch, type ClientDocument, type DocumentOperation, type ServerCommit,
  type Text, type TextChangeEvent,
} from "../src/index.ts";
import { RuntimeText, TextState } from "../src/text.ts";

const Board = defineDocument({ body: text(), other: text(), count: value(0), items: list<string>() });
type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;
type Commit = ServerCommit<DocumentOperation<Shape>>;
type Doc = ClientDocument<Shape>;
const json = (input: unknown): unknown => JSON.parse(JSON.stringify(input));
const wire = (commit: Commit) => decodeServerCommit(Board, json(commit));

function mirror(body: Text, callback?: (event: TextChangeEvent) => void) {
  let elements = [...body];
  const events: TextChangeEvent[] = [];
  const stop = body.observe((event) => {
    assert.equal(event.beforeLength, elements.length);
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.changes));
    let previous = elements.length + 1;
    for (const change of event.changes) {
      assert.ok(Object.isFrozen(change) && Object.isFrozen(change.insert));
      assert.ok(change.index >= 0 && change.index < previous);
      assert.ok(change.index + change.deleteCount <= previous);
      elements = elements.slice(0, change.index).concat(change.insert, elements.slice(change.index + change.deleteCount));
      previous = change.index;
    }
    assert.equal(event.afterLength, elements.length);
    assert.deepEqual(elements, [...body]);
    events.push(event);
    callback?.(event);
  });
  return { get elements() { return elements; }, events, stop };
}

function setup() {
  let mode: "accept" | "reject" | "transform" = "accept";
  const server = createServer(Board, { resolve: ({ batch }) => mode === "reject" ? [] :
    mode === "transform" ? batch.operations.map((operation) => operation.type === "text/insert"
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
  return { server, client, catchUp, setMode(next: typeof mode) { mode = next; } };
}

describe("Text visible changes", () => {
  it("starts at the current view and emits frozen, descending edits in original coordinates", () => {
    const { doc } = setup().client();
    doc.state.body.insert(0, "AB");
    const checkpoint = doc.checkpoint();
    const view = mirror(doc.state.body);
    assert.deepEqual(doc.checkpoint(), checkpoint);
    assert.equal(view.events.length, 0);
    doc.state.body.insert(1, "😀");
    assert.deepEqual(view.events[0], { beforeLength: 2, afterLength: 3,
      changes: [{ index: 1, deleteCount: 0, insert: ["😀"] }] });
    doc.transact(() => { doc.state.body.insert(0, "x"); doc.state.body.insert(doc.state.body.length, "y"); });
    assert.deepEqual(view.events[1]?.changes, [
      { index: 3, deleteCount: 0, insert: ["y"] }, { index: 0, deleteCount: 0, insert: ["x"] },
    ]);
    doc.state.body.delete(1, 2);
    assert.deepEqual(view.elements, ["x", "B", "y"]);
    doc.state.body.insert(0, ""); doc.state.body.delete(0, 0);
    assert.equal(view.events.length, 3);
    view.stop(); view.stop();
    doc.state.body.insert(0, "unobserved");
    assert.equal(view.events.length, 3);
  });

  it("preserves separately inserted surrogate elements rather than reparsing a joined string", () => {
    const { doc } = setup().client(), view = mirror(doc.state.body);
    doc.state.body.insert(0, "\ud83d"); doc.state.body.insert(1, "\ude00");
    assert.equal(doc.state.body.toString(), "😀");
    assert.equal(doc.state.body.length, 2);
    assert.deepEqual(view.elements, ["\ud83d", "\ude00"]);
    doc.state.body.delete(0);
    assert.deepEqual(view.elements, ["\ude00"]);
  });

  it("groups nested mixed transactions, rolls back failure, and rejects subscription during a transaction", () => {
    const { doc, batches } = setup().client();
    const body = mirror(doc.state.body), other = mirror(doc.state.other), order: string[] = [];
    doc.on("change", () => order.push("change"));
    doc.state.body.observe(() => order.push("observe"));
    doc.transact(() => {
      doc.state.body.insert(0, "a");
      doc.transact(() => { doc.state.body.insert(1, "😀"); doc.state.other.insert(0, "b"); });
      doc.state.count.value = 1; doc.state.items.push("item");
      assert.equal(body.events.length, 0);
      assert.throws(() => doc.state.body.observe(() => {}));
    });
    assert.equal(batches.length, 1);
    assert.deepEqual(order, ["change", "observe"]);
    assert.equal(body.events.length, 1); assert.equal(other.events.length, 1);
    const error = new Error("rollback");
    assert.throws(() => doc.transact(() => { doc.state.body.delete(0); throw error; }), (cause) => cause === error);
    assert.deepEqual(body.elements, [...doc.state.body]);
    assert.equal(body.events.length, 1);
    doc.transact(() => {});
    assert.equal(body.events.length, 1);
  });

  it("does not notify for ID-only replacement, unrelated edits, or silent own acknowledgement", () => {
    const net = setup(), { doc, batches } = net.client(), view = mirror(doc.state.body);
    doc.state.body.insert(0, "A😀B"); doc.receive(wire(net.server.receive(batches[0]!).commit));
    doc.transact(() => { doc.state.body.delete(1); doc.state.body.insert(1, "😀"); });
    doc.receive(wire(net.server.receive(batches[1]!).commit));
    doc.state.count.value = 2;
    assert.equal(view.events.length, 1);
    assert.deepEqual(view.elements, ["A", "😀", "B"]);
  });

  it("keeps equal text silent when changed IDs redistribute repeated characters across offsets", () => {
    const net = setup(), writer = net.client(), peer = net.client();
    writer.doc.state.body.insert(0, "aaa"); net.server.receive(writer.batches[0]!);
    net.catchUp(writer.doc); net.catchUp(peer.doc);
    const local = mirror(writer.doc.state.body), remote = mirror(peer.doc.state.body);
    writer.doc.transact(() => { writer.doc.state.body.delete(1); writer.doc.state.body.insert(0, "a"); });
    net.server.receive(writer.batches[1]!); net.catchUp(writer.doc); net.catchUp(peer.doc);
    assert.equal(local.events.length, 0); assert.equal(remote.events.length, 0);
    assert.deepEqual(remote.elements, ["a", "a", "a"]);
  });

  it("compares replayed Text with overlapping, masking and disjoint pending work", () => {
    for (const overlap of [false, true]) {
      const net = setup(), writer = net.client(), peer = net.client();
      writer.doc.state.body.insert(0, "A😀B");
      net.server.receive(writer.batches[0]!); net.catchUp(writer.doc); net.catchUp(peer.doc);
      const view = mirror(peer.doc.state.body);
      if (overlap) peer.doc.state.body.delete(1);
      else peer.doc.state.count.value = 1;
      const before = view.events.length, pending = peer.doc.checkpoint().pendingBatches;
      writer.doc.transact(() => { writer.doc.state.body.delete(1); writer.doc.state.body.insert(1, "R"); });
      net.server.receive(writer.batches[1]!); net.catchUp(writer.doc); net.catchUp(peer.doc);
      assert.equal(view.events.length, before + 1);
      assert.deepEqual(view.elements, ["A", "R", "B"]);
      assert.deepEqual(peer.doc.checkpoint().pendingBatches, pending);
      // Both clients delete the same known ID; the peer's pending delete masks it.
      writer.doc.state.body.delete(0);
      peer.doc.state.body.delete(0);
      const count = view.events.length;
      net.server.receive(writer.batches[2]!); net.catchUp(peer.doc);
      assert.equal(view.events.length, count);
    }
  });

  it("handles tombstone anchors and same-batch insert/delete without phantom content", () => {
    const net = setup(), writer = net.client(), peer = net.client();
    writer.doc.state.body.insert(0, "AB"); net.server.receive(writer.batches[0]!);
    net.catchUp(writer.doc); net.catchUp(peer.doc);
    const view = mirror(peer.doc.state.body);
    peer.doc.state.body.insert(1, "😀");
    writer.doc.state.body.delete(0); net.server.receive(writer.batches[1]!); net.catchUp(peer.doc);
    assert.deepEqual(view.elements, ["😀", "B"]);
    const count = view.events.length;
    writer.doc.transact(() => { writer.doc.state.body.insert(0, "X"); writer.doc.state.body.delete(0); });
    net.server.receive(writer.batches[2]!); net.catchUp(peer.doc);
    assert.equal(view.events.length, count);
  });

  it("falls back for rejection and a blocked suffix, including an empty commit clearing the view", () => {
    const net = setup(), { doc, batches } = net.client(), view = mirror(doc.state.body);
    doc.state.body.insert(0, "A"); doc.state.body.insert(1, "B");
    doc.receive(wire(net.server.reject(batches[0]!).commit));
    assert.deepEqual(view.elements, []);
    assert.equal(doc.replayConflict?.batch.seq, 2);
    assert.equal(doc.checkpoint().pendingBatches.length, 1);
    const count = view.events.length;
    doc.receive(wire(net.server.reject(batches[1]!).commit));
    assert.equal(doc.replayConflict, null);
    assert.equal(view.events.length, count);
    doc.state.body.insert(0, "recovered");
    assert.deepEqual(view.elements, [...doc.state.body]);
  });

  it("restores blocked mixed prefixes on paths absent from the repairing commit", () => {
    const net = setup(), { doc, batches } = net.client(), peer = net.client();
    doc.state.body.insert(0, "A");
    doc.transact(() => { doc.state.body.insert(1, "B"); doc.state.other.insert(0, "visible again"); });
    const body = mirror(doc.state.body), other = mirror(doc.state.other);
    doc.receive(wire(net.server.reject(batches[0]!).commit));
    assert.deepEqual(other.elements, []);
    const original = batches[0]!.operations[0]!;
    assert.equal(original.type, "text/insert");
    if (original.type !== "text/insert") throw new Error("expected insertion");
    // A trusted resolver may restore the original anchor with a foreign authoritative ID.
    const repairingServer = createServer(Board, { checkpoint: net.server.checkpoint(),
      resolve: () => [original] });
    peer.doc.state.count.value = 1;
    doc.receive(wire(repairingServer.receive(peer.batches[0]!).commit));
    assert.equal(doc.replayConflict, null);
    assert.deepEqual(body.elements, ["A", "B"]);
    assert.deepEqual(other.elements, Array.from("visible again"));
  });

  it("coalesces synchronous onBatch transformation after legacy callbacks", () => {
    const net = setup(); net.setMode("transform");
    const order: string[] = [];
    let doc: Doc;
    doc = createClient(Board, { clientId: net.server.openClient(), onBatch(batch) {
      order.push("onBatch"); doc.receive(wire(net.server.receive(batch).commit));
    } });
    doc.on("change", ({ origin }) => order.push(origin));
    const view = mirror(doc.state.body, () => order.push("observe"));
    doc.state.body.insert(0, "a");
    assert.deepEqual(order, ["onBatch", "server", "local", "observe"]);
    assert.equal(view.events.length, 1);
    assert.deepEqual(view.events[0]?.changes, [{ index: 0, deleteCount: 0, insert: ["A"] }]);
  });

  it("adopts transformed own text and restored pending without treating metadata as a text change", () => {
    const net = setup(), { doc, batches } = net.client();
    doc.state.body.insert(0, "ab😀"); doc.state.body.insert(3, "c");
    const saved = decodeClientCheckpoint(Board, json(doc.checkpoint()));
    const restored = createClient(Board, { clientId: saved.clientId, checkpoint: saved, onBatch() {} });
    const view = mirror(restored.state.body);
    net.setMode("transform");
    restored.receive(wire(net.server.receive(batches[0]!).commit));
    assert.deepEqual(view.elements, ["A", "B", "😀", "c"]);
    restored.receive(wire(net.server.receive(batches[1]!).commit));
    assert.deepEqual(view.elements, ["A", "B", "😀", "C"]);
    assert.equal(restored.checkpoint().pendingBatches.length, 0);
  });

  it("falls back when a transformed anchor relocates dependent pending IDs", () => {
    const net = setup(), { doc, batches } = net.client();
    doc.state.body.insert(0, "AB"); doc.receive(wire(net.server.receive(batches[0]!).commit));
    const seed = batches[0]!.operations[0]!;
    assert.ok(seed.type === "text/insert");
    const server = createServer(Board, { checkpoint: net.server.checkpoint(), resolve: ({ batch }) =>
      batch.operations.map((operation) => operation.type === "text/insert" ? {
        ...operation, before: { bunchId: seed.id.bunchId, counter: seed.id.counter + 1 },
      } : operation) });
    doc.state.body.insert(1, "x"); doc.state.body.insert(2, "y");
    const view = mirror(doc.state.body);
    doc.receive(wire(server.receive(batches[1]!).commit));
    assert.deepEqual(view.elements, ["A", "B", "x", "y"]);
    assert.equal(doc.checkpoint().pendingBatches[0]?.seq, 3);
  });

  it("retains observer baselines when onBatch throws, then catches up on a silent ack", () => {
    const net = setup(), error = new Error("onBatch"), batches: Batch[] = [];
    const doc = createClient(Board, { clientId: net.server.openClient(), onBatch(batch) { batches.push(batch); throw error; } });
    const view = mirror(doc.state.body);
    assert.throws(() => doc.state.body.insert(0, "A"), (cause) => cause === error);
    assert.equal(view.events.length, 0);
    assert.equal(doc.checkpoint().lastLocalSeq, 1);
    doc.receive(wire(net.server.receive(batches[0]!).commit));
    assert.deepEqual(view.elements, ["A"]);
    assert.equal(view.events.length, 1);
  });

  it("preserves a legacy listener error and delivers accumulated text after a later success", () => {
    const net = setup(), writer = net.client(), peer = net.client(), error = new Error("listener");
    const view = mirror(peer.doc.state.body);
    const off = peer.doc.on("change", () => { throw error; });
    writer.doc.state.body.insert(0, "A");
    const commit = wire(net.server.receive(writer.batches[0]!).commit);
    assert.throws(() => peer.doc.receive(commit), (cause) => cause === error);
    assert.equal(view.events.length, 0);
    assert.equal(peer.doc.checkpoint().snapshot.serverSeq, commit.serverSeq);
    off(); peer.doc.state.count.value = 1;
    assert.deepEqual(view.elements, ["A"]);
  });

  it("advances only invoked observer baselines on failure and leaves the document usable", () => {
    const { doc } = setup().client(), error = new Error("observer");
    let calls = 0;
    const off = doc.state.body.observe(() => { calls++; throw error; });
    const view = mirror(doc.state.body);
    assert.throws(() => doc.state.body.insert(0, "A"), (cause) => cause === error);
    assert.equal(calls, 1); assert.equal(view.events.length, 0);
    assert.equal(doc.checkpoint().pendingBatches.length, 1);
    off(); doc.state.count.value = 1;
    assert.deepEqual(view.elements, ["A"]);
    doc.state.body.insert(1, "B");
    assert.deepEqual(view.elements, ["A", "B"]);
  });

  it("drains reentrant observers without recursion and keeps independent subscription baselines", () => {
    const { doc } = setup().client();
    let depth = 0, maxDepth = 0;
    const first = mirror(doc.state.body, () => {
      depth++; maxDepth = Math.max(depth, maxDepth);
      if (doc.state.body.length === 1) doc.state.body.insert(1, "B");
      depth--;
    });
    const second = mirror(doc.state.body);
    doc.state.body.insert(0, "A");
    assert.equal(maxDepth, 1);
    assert.equal(first.events.length, 2); assert.equal(second.events.length, 1);
    assert.deepEqual(first.elements, second.elements);
    assert.deepEqual(second.elements, ["A", "B"]);
  });

  it("coalesces legacy listener mutations across Text paths before notifying their observers", () => {
    const { doc } = setup().client();
    const body = mirror(doc.state.body), other = mirror(doc.state.other);
    let nested = false;
    doc.on("change", () => {
      if (nested) return;
      nested = true;
      doc.state.body.insert(doc.state.body.length, "B");
      doc.state.other.insert(0, "C");
    });
    doc.state.body.insert(0, "A");
    assert.deepEqual(body.elements, ["A", "B"]);
    assert.deepEqual(other.elements, ["C"]);
    assert.equal(body.events.length, 1); assert.equal(other.events.length, 1);
  });

  it("retains tracked edits if an observer mutates and then throws", () => {
    const { doc } = setup().client(), error = new Error("after nested mutation");
    let calls = 0;
    const first = mirror(doc.state.body, () => {
      if (calls++ === 0) { doc.state.body.insert(1, "B"); throw error; }
    });
    const second = mirror(doc.state.body);
    assert.throws(() => doc.state.body.insert(0, "A"), (cause) => cause === error);
    assert.deepEqual(first.elements, ["A"]); assert.deepEqual(second.elements, []);
    doc.state.count.value = 1;
    assert.deepEqual(first.elements, ["A", "B"]);
    assert.deepEqual(second.elements, first.elements);
    assert.equal(doc.checkpoint().pendingBatches.length, 3);
  });

  it("handles unsubscribe and new subscriptions during delivery without sending past changes", () => {
    const { doc } = setup().client();
    let stop = () => {}, late: ReturnType<typeof mirror> | undefined;
    doc.state.body.observe(() => { stop(); late ??= mirror(doc.state.body); });
    let removedCalls = 0;
    stop = doc.state.body.observe(() => { removedCalls++; });
    doc.state.body.insert(0, "A");
    assert.equal(removedCalls, 0); assert.equal(late?.events.length, 0);
    doc.state.body.insert(1, "B");
    assert.deepEqual(late?.elements, ["A", "B"]);
  });

  it("keeps invalid receives atomic and does not notify or corrupt subsequent target tracking", () => {
    const net = setup(), writer = net.client(), peer = net.client(), view = mirror(peer.doc.state.body);
    writer.doc.state.body.insert(0, "A"); const commit = net.server.receive(writer.batches[0]!).commit;
    const before = peer.doc.checkpoint();
    assert.throws(() => peer.doc.receive({ ...commit, serverSeq: 2 }));
    assert.throws(() => peer.doc.receive({ ...commit, operations: [{ type: "text/delete", path: "body",
      ranges: [{ start: { bunchId: "unknown", counter: 0 }, count: 1 }] }] }));
    assert.deepEqual(peer.doc.checkpoint(), before); assert.equal(view.events.length, 0);
    peer.doc.receive(wire(commit));
    assert.deepEqual(view.elements, ["A"]);
  });

  it("does no diff work without subscribers and avoids full materialization for targeted changes", () => {
    const net = setup(), writer = net.client(), peer = net.client();
    const diff = mock.method(TextState.prototype, "changesTo");
    const track = mock.method(RuntimeText.prototype, "track");
    try {
      writer.doc.state.body.insert(0, "AB"); net.server.receive(writer.batches[0]!);
      net.catchUp(writer.doc); net.catchUp(peer.doc);
      assert.equal(diff.mock.callCount(), 0);
      assert.equal(track.mock.callCount(), 0);
    } finally { diff.mock.restore(); track.mock.restore(); }
    const view = mirror(peer.doc.state.body);
    writer.doc.transact(() => { writer.doc.state.body.delete(1); writer.doc.state.body.insert(1, "😀"); });
    const commit = wire(net.server.receive(writer.batches[1]!).commit);
    const values = mock.method(TextState.prototype, "values", () => { throw new Error("full materialization"); });
    // The mirror's independent assertion iterates the runtime too; test the diff itself under the mock.
    view.stop();
    let event: TextChangeEvent | undefined;
    const stop = peer.doc.state.body.observe((next) => { event = next; });
    try { peer.doc.receive(commit); } finally { values.mock.restore(); stop(); }
    assert.deepEqual(event?.changes, [{ index: 1, deleteCount: 1, insert: ["😀"] }]);
  });

  it("does not leave a full-scan flag on unchanged Text after another path's conflict", () => {
    const net = setup(), { doc, batches } = net.client();
    doc.state.body.insert(0, "AB"); doc.receive(wire(net.server.receive(batches[0]!).commit));
    const events: TextChangeEvent[] = [];
    doc.state.body.observe((next) => { events.push(next); });
    doc.state.items.push("anchor"); doc.state.items.set(0, "dependent");
    doc.receive(wire(net.server.reject(batches[1]!).commit));
    assert.ok(doc.replayConflict !== null);
    doc.receive(wire(net.server.reject(batches[2]!).commit));
    assert.equal(doc.replayConflict, null); assert.equal(events.length, 0);
    const values = mock.method(TextState.prototype, "values", () => { throw new Error("stale full fallback"); });
    try { doc.state.body.insert(1, "X"); } finally { values.mock.restore(); }
    assert.deepEqual(events[0]?.changes, [{ index: 1, deleteCount: 0, insert: ["X"] }]);
  });

  it("discards targets for tombstone-only commits when every observer already has the current state", () => {
    const net = setup(), writer = net.client(), peer = net.client();
    writer.doc.state.body.insert(0, "AB"); net.server.receive(writer.batches[0]!);
    net.catchUp(writer.doc); net.catchUp(peer.doc);
    writer.doc.state.body.delete(0); net.server.receive(writer.batches[1]!);
    net.catchUp(peer.doc);
    const view = mirror(peer.doc.state.body);
    for (let seq = 3; seq <= 6; seq++) {
      peer.doc.receive(wire(net.server.receive({ clientId: writer.batches[0]!.clientId,
        seq, operations: writer.batches[1]!.operations }).commit));
    }
    assert.equal(view.events.length, 0);
    // oxlint-disable-next-line typescript/unbound-method -- The scoped mock calls this method with its original TextState receiver below.
    const original = TextState.prototype.changesTo;
    const diff = mock.method(TextState.prototype, "changesTo", function(this: TextState,
      ...args: Parameters<TextState["changesTo"]>) {
      assert.ok(args[1] !== undefined);
      const ids = [...args[1]];
      assert.equal(ids.length, 1, "only the new insertion target should remain");
      return original.call(this, args[0], ids);
    });
    try { peer.doc.state.body.insert(0, "X"); } finally { diff.mock.restore(); }
    assert.deepEqual(view.elements, ["X", "B"]);
  });

  for (const seed of [1, 42, 2026]) it(`keeps independent mirrors correct under interleaving seed=${seed}`, () => {
    const net = setup();
    const clients = [net.client(), net.client()];
    let views = clients.map(({ doc }) => [mirror(doc.state.body), mirror(doc.state.other)]);
    let state = seed;
    const random = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
    for (let step = 0; step < 160; step++) {
      const index = random(2), target = clients[index]!, action = random(6);
      try {
        if (action < 2 && target.doc.replayConflict === null) {
          const body = action === 0 ? target.doc.state.body : target.doc.state.other;
          target.doc.transact(() => {
            if (body.length > 0 && random(2) === 0) body.delete(random(body.length));
            body.insert(random(body.length + 1), random(3) === 0 ? "😀" : "a");
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
          for (const view of views[index]!) view.stop();
          target.doc = createClient(Board, { clientId: saved.clientId, checkpoint: saved, onBatch() {} });
          views[index] = [mirror(target.doc.state.body), mirror(target.doc.state.other)];
        } else if (target.doc.replayConflict === null) target.doc.state.count.value = step;
        for (const [i, client] of clients.entries()) {
          assert.deepEqual(views[i]![0]!.elements, [...client.doc.state.body]);
          assert.deepEqual(views[i]![1]!.elements, [...client.doc.state.other]);
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
      assert.deepEqual([...target.doc.state.body], [...clients[0]!.doc.state.body]);
      assert.deepEqual(target.doc.checkpoint().pendingBatches, []);
    }
    views = [];
  });
});
