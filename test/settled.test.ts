import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient, createServer, decodeClientCheckpoint, decodeServerCommit, defineDocument, list, value,
  type BatchOutcome, type ClientBatch, type DocumentOperation, type ServerCommit,
} from "../src/index.ts";

const Board = defineDocument({ items: list<string>(), count: value(0) });
type Shape = typeof Board.definition;
type Operation = DocumentOperation<Shape>;
type Batch = ClientBatch<Operation>;
type Commit = ServerCommit<Operation>;
const json = (input: unknown): unknown => JSON.parse(JSON.stringify(input));
const summary = (outcome: BatchOutcome<Operation> | undefined) => outcome === undefined ? undefined : {
  status: outcome.status,
  dropped: outcome.dropped.map((operation) => operation.type),
  added: outcome.added.map((operation) => operation.type),
  discarded: outcome.discarded.map((operation) => operation.type),
};

function setup() {
  let resolve: ((batch: Batch) => readonly Operation[]) | undefined;
  const server = createServer(Board, { resolve: ({ batch }) => resolve?.(batch) ?? batch.operations });
  const client = () => {
    const batches: Batch[] = [];
    const doc = createClient(Board, { clientId: server.openClient(), onBatch(batch) { batches.push(batch); } });
    return { doc, batches };
  };
  /** The commit of a writer's next batch, decoded as a remote client receives it. */
  const submit = (writer: { batches: Batch[] }, reject = false): Commit => {
    const batch = writer.batches.shift()!;
    return decodeServerCommit(Board, json((reject ? server.reject(batch) : server.receive(batch)).commit));
  };
  const setResolve = (next: typeof resolve) => { resolve = next; };
  return { server, client, submit, setResolve };
}

describe("Tracked batch outcomes", () => {
  it("resolves accepted, transformed and rejected outcomes once acknowledged", async () => {
    const { client, submit, setResolve } = setup();
    const a = client();
    const accepted = a.doc.track(() => { a.doc.state.items.push("x"); return "value"; });
    assert.equal(accepted.value, "value");
    assert.deepEqual(accepted.batch, a.doc.checkpoint().pendingBatches[0]);
    a.doc.receive(submit(a));
    const outcome = await accepted.settled;
    assert.deepEqual(summary(outcome), { status: "accepted", dropped: [], added: [], discarded: [] });
    assert.ok(Object.isFrozen(outcome) && Object.isFrozen(outcome?.dropped) && Object.isFrozen(outcome?.discarded));
    assert.strictEqual(outcome?.batch, accepted.batch);

    setResolve((batch) => batch.operations.map((operation) =>
      operation.type === "value/set" ? { ...operation, value: 10 } : operation));
    const transformed = a.doc.track(() => { a.doc.state.count.set(12); });
    const commit = submit(a);
    a.doc.receive(commit);
    const changed = await transformed.settled;
    assert.deepEqual(summary(changed), { status: "transformed", dropped: ["value/set"], added: ["value/set"], discarded: [] });
    assert.strictEqual(changed?.commit, commit);

    setResolve(() => []);
    const emptied = a.doc.track(() => { a.doc.state.count.set(3); });
    a.doc.receive(submit(a));
    setResolve(undefined);
    const rejected = a.doc.track(() => { a.doc.state.items.push("y"); });
    a.doc.receive(submit(a, true));
    assert.deepEqual([summary(await emptied.settled), summary(await rejected.settled)], [
      { status: "rejected", dropped: ["value/set"], added: [], discarded: [] },
      { status: "rejected", dropped: ["list/insert"], added: [], discarded: [] },
    ]);
  });

  it("reports sets on a deleted element as discarded within an accepted outcome", async () => {
    const { client, submit } = setup();
    const a = client(), b = client();
    a.doc.state.items.push("x");
    const seeded = submit(a);
    a.doc.receive(seeded); b.doc.receive(seeded);
    const set = a.doc.track(() => { a.doc.state.items.set(0, "edited"); });
    b.doc.state.items.delete(0);
    const deletion = submit(b);
    a.doc.receive(deletion);
    a.doc.receive(submit(a));
    assert.deepEqual(summary(await set.settled), { status: "accepted", dropped: [], added: [], discarded: ["list/set"] });
  });

  it("follows transact: no batch, rollback, nesting and synchronous acknowledgements", async () => {
    const { client, server } = setup();
    const a = client();
    const nothing = a.doc.track(() => 1);
    assert.deepEqual([nothing.value, nothing.batch, await nothing.settled], [1, undefined, undefined]);
    const failure = new Error("callback failed");
    assert.throws(() => a.doc.track(() => { a.doc.state.items.push("rolled back"); throw failure; }), (error) => error === failure);
    assert.deepEqual([a.doc.state.items.toArray(), a.batches.length], [[], 0]);
    assert.throws(() => a.doc.transact(() => a.doc.track(() => {})), /inside a transaction/);

    // A transport that acknowledges inside onBatch settles before track() returns.
    let doc!: ReturnType<typeof createClient<Shape>>;
    doc = createClient(Board, { clientId: server.openClient(), onBatch(batch) { doc.receive(server.receive(batch).commit); } });
    const immediate = doc.track(() => { doc.state.count.set(4); });
    assert.equal(immediate.batch?.seq, 1);
    assert.equal((await immediate.settled)?.status, "accepted");
  });

  it("settles any pending batch, including restored ones, with one promise per batch", async () => {
    const { client, server, submit } = setup();
    const a = client();
    a.doc.state.items.push("offline");
    const saved = decodeClientCheckpoint(Board, json(a.doc.checkpoint()));
    const restored = createClient(Board, { clientId: saved.clientId, checkpoint: saved, onBatch() {} });
    const [pending] = restored.checkpoint().pendingBatches;
    assert.ok(pending !== undefined);
    const promise = restored.settled(pending);
    assert.strictEqual(restored.settled(pending), promise);
    restored.receive(server.receive(saved.pendingBatches[0]!).commit);
    assert.equal((await promise).status, "accepted");
    assert.throws(() => restored.settled(pending), /not pending/, "already acknowledged");
    assert.throws(() => a.doc.settled({ ...pending, clientId: "someone-else" }), /not pending/);
    assert.throws(() => a.doc.settled({ ...pending, seq: 99 }), /not pending/);
    a.doc.receive(submit(a));
  });

  it("resolves before listeners run, so a throwing listener cannot leave it pending", async () => {
    const { client, submit, setResolve } = setup();
    const a = client();
    const order: string[] = [];
    const failure = new Error("listener failed");
    a.doc.on("transform", () => { order.push("transform"); throw failure; });
    setResolve(() => []);
    const tracked = a.doc.track(() => { a.doc.state.count.set(1); });
    void tracked.settled.then(() => order.push("settled"));
    assert.throws(() => a.doc.receive(submit(a)), (error) => error === failure);
    assert.deepEqual(order, ["transform"], "promise callbacks run after receive() returns");
    assert.equal((await tracked.settled)?.status, "rejected");
    assert.deepEqual(order, ["transform", "settled"]);
  });
});
