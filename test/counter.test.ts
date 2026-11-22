import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  counter, counters, createClient, createServer, createUndoManager, decodeClientBatch, decodeClientCheckpoint,
  decodeServerCommit, decodeSnapshot, defineDocument, value, WireDecodeError,
  type ClientBatch, type ClientDocument, type CounterMapChangeEvent, type DocumentOperation, type ServerCommit,
} from "../src/index.ts";

const Board = defineDocument({ likes: counter(), stock: counter(10), votes: counters(), title: value("") });
type Shape = typeof Board.definition;
type Operation = DocumentOperation<Shape>;
type Batch = ClientBatch<Operation>;
type Commit = ServerCommit<Operation>;
type Doc = ClientDocument<Shape>;
const wire = (input: unknown): unknown => JSON.parse(JSON.stringify(input));

function setup(resolve?: (batch: Batch) => readonly Operation[]) {
  const server = createServer(Board, resolve === undefined ? {} : { resolve: ({ batch }) => resolve(batch) });
  const client = () => {
    const batches: Batch[] = [];
    const doc = createClient(Board, { clientId: server.openClient(), onBatch(batch) { batches.push(batch); } });
    return { doc, batches };
  };
  /** Sends one batch over the wire and delivers its commit, also over the wire, to every document. */
  const submit = (writer: { batches: Batch[] }, ...docs: Doc[]): Commit => {
    const { commit } = server.receive(decodeClientBatch(Board, wire(writer.batches.shift()!)));
    for (const doc of docs) doc.receive(decodeServerCommit(Board, wire(commit)));
    return commit;
  };
  return { server, client, submit };
}

describe("Counter collection", () => {
  it("adds concurrent increments instead of losing one, as value/set would", () => {
    const { server, client, submit } = setup();
    const a = client(), b = client(), x = client(), y = client();
    a.doc.state.likes.add(1);
    b.doc.state.likes.add(1);
    a.doc.state.stock.add(-3);
    assert.deepEqual(a.batches[0]!.operations, [{ type: "counter/add", path: "likes", delta: 1 }]);
    assert.equal(a.doc.state.stock.value, 7, "the initial value counts");
    submit(a, a.doc, b.doc);
    // B's pending +1 replays on top of A's committed +1.
    assert.equal(b.doc.state.likes.value, 2);
    submit(b, a.doc, b.doc);
    submit(a, a.doc, b.doc);
    assert.deepEqual([a.doc.state.likes.value, b.doc.state.likes.value, server.snapshot().data.likes], [2, 2, 2]);
    assert.equal(server.snapshot().data.stock, 7);

    // For contrast: two writers setting value + 1 lose one write.
    x.doc.state.title.set(`${x.doc.state.title.value}!`);
    y.doc.state.title.set(`${y.doc.state.title.value}!`);
    submit(x); submit(y);
    assert.equal(server.snapshot().data.title, "!");
  });

  it("validates deltas and initial values, and refuses totals outside the safe integer range", () => {
    const { client, server } = setup();
    const { doc, batches } = client();
    for (const delta of [1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => { doc.state.likes.add(delta); }, TypeError, String(delta));
    }
    // @ts-expect-error A delta is a number.
    assert.throws(() => { doc.state.likes.add("1"); }, TypeError);
    doc.state.likes.add(0);
    assert.equal(batches.length, 0, "adding 0 records nothing");
    doc.state.likes.add(Number.MAX_SAFE_INTEGER);
    assert.throws(() => { doc.state.likes.add(1); }, RangeError);
    assert.equal(doc.state.likes.value, Number.MAX_SAFE_INTEGER, "a refused addition changes nothing");
    assert.equal(batches.length, 1);
    for (const initial of [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => counter(initial), TypeError);

    // Two writers that each stay in range can overflow together: a replay conflict, and the server refuses it.
    const other = createClient(Board, { clientId: server.openClient(), onBatch() {} });
    other.state.likes.add(1);
    const otherBatch = wire({ clientId: other.checkpoint().clientId, seq: 1, operations: [{ type: "counter/add", path: "likes", delta: 1 }] });
    server.receive(decodeClientBatch(Board, otherBatch));
    assert.throws(() => server.receive(decodeClientBatch(Board, wire(batches[0]))), /safe integer range/);
  });

  it("reports a replay that would leave the safe integer range as a conflict", () => {
    const { client, server } = setup();
    const a = client(), b = client();
    b.doc.state.likes.add(Number.MAX_SAFE_INTEGER);
    const { commit } = server.receive(decodeClientBatch(Board, wire(b.batches.shift()!)));
    a.doc.state.likes.add(1);
    a.doc.receive(decodeServerCommit(Board, wire(commit)));
    assert.equal(a.doc.replayConflict?.operationIndex, 0);
    assert.equal(a.doc.state.likes.value, Number.MAX_SAFE_INTEGER, "the conflicting batch is not shown");
  });
});

describe("CounterMap collection", () => {
  it("counts by key, treats absent keys as 0 and removes a key whose total is 0", () => {
    const { client, submit, server } = setup();
    const a = client(), b = client();
    const votes = a.doc.state.votes;
    assert.equal(votes.get("card"), 0);
    votes.add("card", 2);
    votes.add("other", 1);
    b.doc.state.votes.add("card", -2);
    assert.deepEqual(a.batches[0]!.operations, [{ type: "counters/add", path: "votes", key: "card", delta: 2 }]);
    assert.deepEqual([votes.size, [...votes.keys()], [...votes.values()], votes.toObject()],
      [2, ["card", "other"], [2, 1], { card: 2, other: 1 }]);
    submit(a, a.doc, b.doc); submit(a, a.doc, b.doc); submit(b, a.doc, b.doc);
    assert.deepEqual([votes.has("card"), votes.get("card"), [...votes]], [false, 0, [["other", 1]]]);
    assert.deepEqual(server.snapshot().data.votes, { other: 1 }, "a snapshot never stores 0");
  });

  it("resets a key with delete, and later additions in server order count again", () => {
    const { client, submit, server } = setup();
    const a = client(), b = client();
    a.doc.state.votes.add("card", 5);
    submit(a, a.doc, b.doc);
    b.doc.state.votes.delete("card"); // B saw 5.
    a.doc.state.votes.add("card", 1); // Concurrent with the reset.
    assert.equal(a.doc.state.votes.delete("never"), false, "delete reports whether the key was counted here");
    assert.deepEqual(b.batches[0]!.operations, [{ type: "counters/delete", path: "votes", key: "card" }]);
    submit(b, a.doc, b.doc);
    assert.equal(a.doc.state.votes.get("card"), 1, "A's pending addition replays after the reset");
    submit(a, a.doc, b.doc); submit(a, a.doc, b.doc);
    assert.deepEqual(server.snapshot().data.votes, { card: 1 });
    assert.equal(b.doc.state.votes.get("card"), 1);
  });

  it("observes each key's change with 0 for an absent key", () => {
    const { client, submit } = setup();
    const a = client(), b = client();
    const events: CounterMapChangeEvent[] = [];
    b.doc.state.votes.observe((event) => { events.push(event); });
    a.doc.state.votes.add("x", 2);
    submit(a, a.doc, b.doc);
    b.doc.state.votes.add("x", -2);
    b.doc.state.votes.add("y", 1);
    assert.deepEqual(events.map(({ changes }) => changes), [
      [{ key: "x", value: 2, previous: 0 }],
      [{ key: "x", value: 0, previous: 2 }],
      [{ key: "y", value: 1, previous: 0 }],
    ]);
  });
});

describe("Counter wire format", () => {
  const batch = (operation: unknown) => ({ clientId: "client-1", seq: 1, operations: [operation] });

  it("decodes exact operations and refuses malformed ones", () => {
    assert.deepEqual(decodeClientBatch(Board, batch({ type: "counter/add", path: "likes", delta: -4 })).operations,
      [{ type: "counter/add", path: "likes", delta: -4 }]);
    assert.deepEqual(decodeClientBatch(Board, batch({ type: "counters/delete", path: "votes", key: "" })).operations,
      [{ type: "counters/delete", path: "votes", key: "" }]);
    for (const operation of [
      { type: "counter/add", path: "likes", delta: 0 },
      { type: "counter/add", path: "likes", delta: 1.5 },
      { type: "counter/add", path: "likes", delta: "1" },
      { type: "counter/add", path: "likes", delta: Number.MAX_SAFE_INTEGER + 1 },
      { type: "counter/add", path: "likes", delta: 1, extra: true },
      { type: "counter/add", path: "votes", delta: 1 },
      { type: "counters/add", path: "votes", key: 1, delta: 1 },
      { type: "counters/add", path: "likes", key: "k", delta: 1 },
      { type: "counters/delete", path: "votes", key: "k", delta: 1 },
      { type: "value/set", path: "likes", value: 3 },
    ]) assert.throws(() => decodeClientBatch(Board, batch(operation)), WireDecodeError, JSON.stringify(operation));
  });

  it("round-trips snapshots and checkpoints and refuses invalid counts", () => {
    const { client, submit, server } = setup();
    const a = client();
    a.doc.state.likes.add(3);
    a.doc.state.votes.add("card", 2);
    submit(a, a.doc); submit(a, a.doc);
    a.doc.state.votes.add("card", 1); // Pending in the checkpoint.
    const restored = createClient(Board, {
      clientId: a.doc.checkpoint().clientId, checkpoint: decodeClientCheckpoint(Board, wire(a.doc.checkpoint())), onBatch() {},
    });
    assert.deepEqual([restored.state.likes.value, restored.state.votes.toObject()], [3, { card: 3 }]);
    const data = (overrides: object) => ({ serverSeq: 0, data: { likes: 0, stock: 10, votes: {}, title: "", ...overrides } });
    assert.deepEqual(decodeSnapshot(Board, wire(server.snapshot())).data, { likes: 3, stock: 10, votes: { card: 2 }, title: "" });
    for (const bad of [{ likes: 1.5 }, { likes: "1" }, { votes: { card: 0 } }, { votes: { card: 0.5 } }, { votes: [] }]) {
      assert.throws(() => decodeSnapshot(Board, data(bad)), WireDecodeError, JSON.stringify(bad));
    }
  });
});

describe("Counter outcomes and undo", () => {
  it("reports a delta the server changed as a transform", async () => {
    // The server allows at most 3 votes per batch.
    const { client, submit } = setup((batch) => batch.operations.map((operation) =>
      operation.type === "counters/add" && operation.delta > 3 ? { ...operation, delta: 3 } : operation));
    const a = client();
    const tracked = a.doc.track(() => { a.doc.state.votes.add("card", 5); });
    submit(a, a.doc);
    const outcome = await tracked.settled;
    assert.equal(outcome?.status, "transformed");
    assert.deepEqual([outcome?.dropped, outcome?.added], [
      [{ type: "counters/add", path: "votes", key: "card", delta: 5 }],
      [{ type: "counters/add", path: "votes", key: "card", delta: 3 }],
    ]);
    assert.equal(a.doc.state.votes.get("card"), 3);
  });

  it("undoes and redoes only this writer's additions, whatever others added since", () => {
    const { client, submit } = setup();
    const a = client(), b = client();
    const history = createUndoManager(a.doc, { captureTimeout: 0 });
    a.doc.state.likes.add(2);
    a.doc.state.votes.add("card", 1);
    b.doc.state.likes.add(10);
    b.doc.state.votes.add("card", 4);
    submit(b, a.doc, b.doc); submit(b, a.doc, b.doc);
    assert.equal(history.undo(), true);
    assert.equal(a.doc.state.votes.get("card"), 4, "B's votes stay");
    assert.equal(history.undo(), true);
    assert.equal(a.doc.state.likes.value, 10);
    assert.equal(history.redo(), true);
    assert.equal(a.doc.state.likes.value, 12);
    while (a.batches.length > 0) submit(a, a.doc, b.doc);
    assert.deepEqual([b.doc.state.likes.value, b.doc.state.votes.get("card")], [12, 4]);
  });

  it("undoes a reset by adding back what it removed, and reverts nothing for a step whose total is 0", () => {
    const { client, submit } = setup();
    const a = client(), b = client();
    a.doc.state.votes.add("card", 3);
    submit(a, a.doc, b.doc);
    const history = createUndoManager(a.doc, { captureTimeout: 0 });
    a.doc.state.votes.delete("card");
    submit(a, a.doc, b.doc);
    b.doc.state.votes.add("card", 1);
    submit(b, a.doc, b.doc);
    assert.equal(a.doc.state.votes.get("card"), 1);
    history.undo();
    assert.equal(a.doc.state.votes.get("card"), 4, "the removed 3 come back on top of B's vote");
    history.clear();
    const end = history.startGroup();
    a.doc.state.likes.add(1);
    a.doc.state.likes.add(-1);
    end();
    const recorded = a.batches.length;
    assert.equal(history.undo(), false, "a group whose additions cancel out has nothing to revert");
    assert.deepEqual([a.doc.state.likes.value, a.batches.length], [0, recorded]);
  });
});
