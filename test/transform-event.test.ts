import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient, createServer, decodeClientCheckpoint, decodeServerCommit, defineDocument, list, map, value,
  type ClientBatch, type ClientDocument, type DocumentOperation, type ServerCommit, type TransformEvent,
} from "../packages/articollab/src/index.ts";

const Board = defineDocument({ items: list<string>(), count: value(0), notes: map<{ text: string; done: boolean }>() });
type Shape = typeof Board.definition;
type Operation = DocumentOperation<Shape>;
type Batch = ClientBatch<Operation>;
type Commit = ServerCommit<Operation>;
type Doc = ClientDocument<Shape>;
const json = (input: unknown): unknown => JSON.parse(JSON.stringify(input));

function setup() {
  let resolve: ((batch: Batch) => readonly Operation[]) | undefined;
  const server = createServer(Board, { resolve: ({ batch }) => resolve?.(batch) ?? batch.operations });
  const client = () => {
    const batches: Batch[] = [];
    const doc = createClient(Board, { clientId: server.openClient(), onBatch(batch) { batches.push(batch); } });
    const transforms: TransformEvent<Operation>[] = [];
    doc.on("transform", (event) => transforms.push(event));
    return { doc, batches, transforms };
  };
  /** Submits a writer's next pending batch; returns the commit without delivering it. */
  const submit = (writer: { batches: Batch[] }, reject = false): Commit => {
    const batch = writer.batches.shift()!;
    return (reject ? server.reject(batch) : server.receive(batch)).commit;
  };
  /** The commit as a remote writer sees it: decoded from JSON, so payloads are copies. */
  const wire = (commit: Commit): Commit => decodeServerCommit(Board, json(commit));
  const deliver = (commit: Commit, ...docs: Doc[]) => { for (const doc of docs) doc.receive(commit); };
  const setResolve = (next: typeof resolve) => { resolve = next; };
  return { server, client, submit, wire, deliver, setResolve };
}

const summary = (operations: readonly Operation[]) => operations.map((operation) =>
  operation.type === "value/set" ? `count=${operation.value}`
    : operation.type === "list/insert" ? `insert ${operation.value}`
      : operation.type === "map/set" ? `note ${operation.key}=${JSON.stringify(operation.value)}`
        : operation.type);

describe("Transformed own batches", () => {
  it("stays silent for exact acknowledgements, including decoded ones and reordered object keys", () => {
    const { client, submit, wire, deliver, setResolve } = setup();
    const a = client(), b = client();
    a.doc.transact(() => {
      a.doc.state.items.push("a");
      a.doc.state.count.set(-0);
      a.doc.state.notes.set("n", { text: "hi", done: false });
    });
    deliver(wire(submit(a)), a.doc, b.doc);
    setResolve((batch) => batch.operations.map((operation) => operation.type === "map/set"
      ? { ...operation, value: { done: operation.value.done, text: operation.value.text } } : operation));
    a.doc.state.notes.set("m", { text: "keys", done: true });
    deliver(submit(a), a.doc, b.doc);
    assert.deepEqual(a.transforms, []);
    assert.deepEqual(b.transforms, [], "peers' commits are never reported");
  });

  it("reports changed, dropped and added operations, each in its own order", () => {
    const { client, submit, wire, deliver, setResolve } = setup();
    const a = client(), b = client();
    setResolve((batch) => [
      { type: "value/set", path: "count", value: 9 },
      ...batch.operations.filter((operation) => operation.type !== "value/set" && !(operation.type === "list/insert" && operation.value === "drop")),
      { type: "map/set", path: "notes", key: "server", value: { text: "added", done: false } },
    ]);
    a.doc.transact(() => {
      a.doc.state.items.push("keep");
      a.doc.state.items.push("drop");
      a.doc.state.count.set(1);
    });
    const batch = a.batches[0]!;
    const ack = wire(submit(a));
    deliver(ack, a.doc, b.doc);
    assert.equal(a.transforms.length, 1);
    const [event] = a.transforms;
    assert.ok(event !== undefined);
    assert.strictEqual(event.batch, batch);
    assert.strictEqual(event.commit, ack);
    assert.deepEqual(summary(event.dropped), ["insert drop", "count=1"]);
    assert.deepEqual(summary(event.added), ["count=9", 'note server={"text":"added","done":false}']);
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.dropped) && Object.isFrozen(event.added));
    assert.deepEqual(a.doc.state.count.value, 9);
  });

  it("matches repeated identical operations as a multiset", () => {
    const { client, submit, deliver, setResolve } = setup();
    const a = client();
    a.doc.transact(() => { a.doc.state.count.set(1); a.doc.state.count.set(2); a.doc.state.count.set(1); });
    // Keep one copy of `count=1` and the `count=2`.
    setResolve((batch) => batch.operations.slice(0, 2));
    deliver(submit(a), a.doc);
    assert.deepEqual(summary(a.transforms[0]!.dropped), ["count=1"]);
    assert.deepEqual(a.transforms[0]!.added, []);
    // The same operations in another order differ, but nothing was dropped or added.
    a.doc.transact(() => { a.doc.state.count.set(3); a.doc.state.count.set(4); });
    setResolve((batch) => [...batch.operations].reverse());
    deliver(submit(a), a.doc);
    assert.equal(a.transforms.length, 2);
    assert.deepEqual([a.transforms[1]!.dropped, a.transforms[1]!.added], [[], []]);
  });

  it("reports a rejected batch and a resolver's empty result as everything dropped", () => {
    const { client, submit, deliver, setResolve } = setup();
    const a = client();
    a.doc.state.items.push("x");
    deliver(submit(a, true), a.doc);
    setResolve(() => []);
    a.doc.state.count.set(5);
    deliver(submit(a), a.doc);
    assert.deepEqual(a.transforms.map((event) => [event.commit.operations.length, summary(event.dropped), event.added.length]),
      [[0, ["insert x"], 0], [0, ["count=5"], 0]]);
    assert.deepEqual(a.doc.state.items.toArray(), []);
    assert.equal(a.doc.state.count.value, 0);
  });

  it("runs after change and before discard and observers, and reports restored pending batches", () => {
    const { client, submit, deliver, setResolve, server } = setup();
    const a = client(), b = client();
    a.doc.state.items.push("a");
    deliver(submit(a), a.doc, b.doc);
    const order: string[] = [];
    a.doc.on("change", () => order.push("change"));
    a.doc.on("transform", () => order.push("transform"));
    a.doc.on("discard", () => order.push("discard"));
    a.doc.state.items.observe(() => order.push("observe"));
    a.doc.state.items.set(0, "A");
    order.length = 0;
    // The server deletes the element before applying the set: transformed, and the set is discarded.
    setResolve((batch) => batch.operations.flatMap((operation): Operation[] => operation.type === "list/set"
      ? [{ type: "list/delete", path: operation.path, id: operation.id }, operation] : [operation]));
    deliver(submit(a), a.doc, b.doc);
    setResolve(undefined);
    assert.deepEqual(order, ["change", "transform", "discard", "observe"]);
    assert.deepEqual([summary(a.transforms[0]!.dropped), summary(a.transforms[0]!.added)], [[], ["list/delete"]]);

    a.doc.state.count.set(7);
    const saved = decodeClientCheckpoint(Board, json(a.doc.checkpoint()));
    const restored = createClient(Board, { clientId: saved.clientId, checkpoint: saved, onBatch() {} });
    const seen: string[][] = [];
    restored.on("transform", (event) => seen.push(summary(event.dropped)));
    restored.receive(server.reject(saved.pendingBatches[0]!).commit);
    assert.deepEqual(seen, [["count=7"]]);
  });

  it("stops after unsubscribe and propagates listener failures after applying", () => {
    const { client, submit, deliver, setResolve } = setup();
    const a = client();
    const failure = new Error("listener failed");
    const later: string[] = [];
    const stop = a.doc.on("transform", () => { throw failure; });
    a.doc.on("transform", () => later.push("transform"));
    a.doc.on("discard", () => later.push("discard"));
    setResolve(() => []);
    a.doc.state.count.set(1);
    const ack = submit(a);
    assert.throws(() => a.doc.receive(ack), (error) => error === failure);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, [], "the commit was applied before listeners ran");
    assert.equal(a.doc.checkpoint().snapshot.serverSeq, ack.serverSeq);
    assert.deepEqual(later, [], "later listeners are skipped");
    stop(); stop();
    a.doc.state.count.set(2);
    deliver(submit(a), a.doc);
    assert.deepEqual(later, ["transform"]);
    assert.equal(a.transforms.length, 2);
  });
});
