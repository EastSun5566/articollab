import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient, createServer, decodeClientCheckpoint, decodeServerCommit, defineDocument, list, value,
  type ClientBatch, type ClientDocument, type DiscardEvent, type DocumentOperation, type ServerCommit,
} from "../src/index.ts";

const Board = defineDocument({ items: list<string>(), count: value(0) });
type Shape = typeof Board.definition;
type Operation = DocumentOperation<Shape>;
type Batch = ClientBatch<Operation>;
type Commit = ServerCommit<Operation>;
type Doc = ClientDocument<Shape>;

function setup() {
  let resolve: ((batch: Batch) => readonly Operation[]) | undefined;
  const server = createServer(Board, { resolve: ({ batch }) => resolve?.(batch) ?? batch.operations });
  const client = () => {
    const batches: Batch[] = [];
    const doc = createClient(Board, { clientId: server.openClient(), onBatch(batch) { batches.push(batch); } });
    const discards: DiscardEvent<Operation>[] = [];
    const changes: string[] = [];
    doc.on("discard", (event) => discards.push(event));
    doc.on("change", (event) => changes.push(event.origin));
    return { doc, batches, discards, changes };
  };
  /** Submits a writer's next pending batch; returns the commit without delivering it. */
  const submit = (writer: { batches: Batch[] }, reject = false): Commit => {
    const batch = writer.batches.shift()!;
    return (reject ? server.reject(batch) : server.receive(batch)).commit;
  };
  const deliver = (commit: Commit, ...docs: Doc[]) => { for (const doc of docs) doc.receive(commit); };
  const setResolve = (next: typeof resolve) => { resolve = next; };
  return { server, client, submit, deliver, setResolve };
}

/** Writer A and peer B share items a, b, c. */
function seeded() {
  const net = setup();
  const a = net.client(), b = net.client();
  for (const item of ["a", "b", "c"]) a.doc.state.items.push(item);
  for (let index = 0; index < 3; index++) net.deliver(net.submit(a), a.doc, b.doc);
  a.changes.length = 0; b.changes.length = 0;
  return { ...net, a, b };
}

describe("Discarded list sets", () => {
  it("reports an own set whose element a peer deleted first, even when the ack changes nothing visible", () => {
    const { a, b, submit, deliver } = seeded();
    const id = a.doc.checkpoint().snapshot.data.items.idList[0]!;
    a.doc.state.items.set(1, "B!");
    b.doc.state.items.delete(1);
    deliver(submit(b), a.doc, b.doc);
    assert.deepEqual(a.doc.state.items.toArray(), ["a", "c"]);
    assert.deepEqual(a.changes, ["local", "server"]);
    const ack = submit(a);
    deliver(ack, a.doc, b.doc);
    assert.deepEqual(a.changes, ["local", "server"], "the exact acknowledgement emits no change event");
    assert.equal(a.discards.length, 1);
    const [event] = a.discards;
    assert.strictEqual(event!.commit, ack);
    assert.deepEqual(event!.operations, [{ type: "list/set", path: "items", id: { bunchId: id.bunchId, counter: 1 }, value: "B!" }]);
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event!.operations));
    assert.deepEqual(b.discards, [], "only the writer of the set is told");
  });

  it("reports only the discarded sets of a batch, in commit order, and nothing for applied sets", () => {
    const { a, b, submit, deliver } = seeded();
    a.doc.transact(() => {
      a.doc.state.items.set(0, "A!");
      a.doc.state.items.set(1, "B!");
      a.doc.state.items.set(2, "C!");
    });
    b.doc.transact(() => { b.doc.state.items.delete(2); b.doc.state.items.delete(0); });
    deliver(submit(b), a.doc, b.doc);
    deliver(submit(a), a.doc, b.doc);
    assert.deepEqual(a.discards.map((event) => event.operations.map((operation) => operation.value)), [["A!", "C!"]]);
    assert.deepEqual(a.doc.state.items.toArray(), ["B!"]);

    a.doc.state.items.set(0, "applied");
    deliver(submit(a), a.doc, b.doc);
    assert.equal(a.discards.length, 1, "a set that applied is not reported");
  });

  it("ignores discarded sets in peers' commits and rejected batches", () => {
    const { a, b, submit, deliver } = seeded();
    b.doc.state.items.set(0, "late");
    a.doc.state.items.delete(0);
    deliver(submit(a), a.doc, b.doc);
    deliver(submit(b), a.doc, b.doc);
    assert.deepEqual([a.discards, b.discards.length], [[], 1], "the peer's commit is not reported to A");

    a.doc.state.items.set(0, "rejected");
    b.doc.state.items.delete(0);
    deliver(submit(b), a.doc, b.doc);
    deliver(submit(a, true), a.doc, b.doc);
    assert.deepEqual(a.discards, [], "a rejected commit contains no operations");
  });

  it("detects server transformations, decoded commits and restored clients, before observers run", () => {
    const { a, b, submit, deliver, setResolve, server } = seeded();
    const order: string[] = [];
    a.doc.on("change", () => order.push("change"));
    a.doc.on("discard", () => order.push("discard"));
    a.doc.state.items.observe(() => order.push("observe"));
    setResolve((batch) => batch.operations.flatMap((operation): Operation[] => operation.type === "list/set"
      ? [{ type: "list/delete", path: operation.path, id: operation.id }, operation] : [operation]));
    a.doc.state.items.set(0, "gone");
    order.length = 0;
    const ack = decodeServerCommit(Board, JSON.parse(JSON.stringify(submit(a))));
    deliver(ack, a.doc, b.doc);
    setResolve(undefined);
    assert.deepEqual(order, ["change", "discard", "observe"]);
    assert.strictEqual(a.discards.at(-1)!.commit, ack);
    assert.deepEqual(a.discards.at(-1)!.operations.map((operation) => operation.value), ["gone"]);

    a.doc.state.items.set(0, "offline");
    const saved = decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(a.doc.checkpoint())));
    const restored = createClient(Board, { clientId: saved.clientId, checkpoint: saved, onBatch() {} });
    const seen: unknown[] = [];
    restored.on("discard", (event) => seen.push(event.operations[0]!.value));
    b.doc.state.items.delete(0);
    const deletion = submit(b);
    deliver(deletion, a.doc, b.doc);
    restored.receive(deletion);
    const own = server.receive(saved.pendingBatches[0]!).commit;
    restored.receive(own);
    assert.deepEqual(seen, ["offline"]);
  });

  it("stops after unsubscribe, propagates listener failures after applying, and keeps unknown events invalid", () => {
    const { a, b, submit, deliver } = seeded();
    const failure = new Error("listener failed");
    const stop = a.doc.on("discard", () => { throw failure; });
    a.doc.state.items.set(0, "x");
    b.doc.state.items.delete(0);
    deliver(submit(b), a.doc, b.doc);
    const ack = submit(a);
    assert.throws(() => a.doc.receive(ack), (error) => error === failure);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, [], "the commit was applied before listeners ran");
    assert.equal(a.doc.checkpoint().snapshot.serverSeq, ack.serverSeq);
    b.doc.receive(ack);
    stop(); stop();
    a.doc.state.items.set(0, "y");
    b.doc.state.items.delete(0);
    deliver(submit(b), a.doc, b.doc);
    deliver(submit(a), a.doc);
    assert.equal(a.discards.length, 2, "remaining listeners still run");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercises an untyped event name.
    assert.throws(() => a.doc.on("other" as "change", () => {}), /Unknown event: other/);
  });
});
