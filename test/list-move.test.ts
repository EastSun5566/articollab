import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertClientBatchNamespace, createClient, createServer, decodeClientBatch, decodeClientCheckpoint,
  decodeServerCheckpoint, decodeSnapshot, defineDocument, list, value, WireDecodeError,
  type ClientBatch, type ClientDocument, type DiscardEvent, type DocumentOperation, type ServerCommit,
} from "../src/index.ts";

const Board = defineDocument({ items: list<string>(), count: value(0) });
type Shape = typeof Board.definition;
type Operation = DocumentOperation<Shape>;
type Batch = ClientBatch<Operation>;
type Commit = ServerCommit<Operation>;
type Doc = ClientDocument<Shape>;
const json = (input: unknown): unknown => JSON.parse(JSON.stringify(input));

function setup(resolve?: (batch: Batch) => readonly Operation[]) {
  const server = createServer(Board, resolve === undefined ? {} : { resolve: ({ batch }) => resolve(batch) });
  const client = () => {
    const batches: Batch[] = [];
    const discards: DiscardEvent<Operation>[] = [];
    const doc = createClient(Board, { clientId: server.openClient(), onBatch(batch) { batches.push(batch); } });
    doc.on("discard", (event) => discards.push(event));
    return { doc, batches, discards };
  };
  const submit = (writer: { batches: Batch[] }): Commit => server.receive(writer.batches.shift()!).commit;
  const deliver = (commit: Commit, ...docs: Doc[]) => { for (const doc of docs) doc.receive(commit); };
  return { server, client, submit, deliver };
}

/** Writers A and B share items a, b, c, d. */
function seeded(resolve?: (batch: Batch) => readonly Operation[]) {
  const net = setup(resolve);
  const a = net.client(), b = net.client();
  a.doc.transact(() => { for (const item of ["a", "b", "c", "d"]) a.doc.state.items.push(item); });
  net.deliver(net.submit(a), a.doc, b.doc);
  return { ...net, a, b };
}

const items = (doc: Doc) => doc.state.items.toArray();

describe("List move", () => {
  it("moves an element so it ends at the target index, in one operation that keeps its ID", () => {
    const { a } = seeded();
    const id = a.doc.checkpoint().snapshot.data.items.idList[0]!;
    a.doc.state.items.move(0, 2);
    assert.deepEqual(items(a.doc), ["b", "c", "a", "d"]);
    const [move] = a.batches.at(-1)!.operations;
    assert.ok(move?.type === "list/move");
    assert.deepEqual(move.id, { bunchId: id.bunchId, counter: 0 }, "the element keeps its original ID");
    assert.deepEqual(move.before, { bunchId: id.bunchId, counter: 2 }, "after c");
    assert.ok(Object.isFrozen(move) && Object.isFrozen(move.position));
    a.doc.state.items.move(3, 0);
    assert.deepEqual(items(a.doc), ["d", "b", "c", "a"]);
    const toStart = a.batches.at(-1)!.operations[0];
    assert.ok(toStart?.type === "list/move");
    assert.equal(toStart.before, null);
    a.doc.state.items.move(1, 3);
    assert.deepEqual(items(a.doc), ["d", "c", "a", "b"]);
    const count = a.batches.length;
    a.doc.state.items.move(2, 2);
    assert.equal(a.batches.length, count, "a move to the same index records nothing");
    for (const [from, to] of [[-1, 0], [0, 4], [1.5, 0], [0, Number.NaN]] as const) {
      assert.throws(() => a.doc.state.items.move(from, to), /out of bounds/);
    }
    assert.equal(a.batches.length, count);
  });

  it("keeps a moved element's identity for later sets, deletes and moves, here and on the server", () => {
    const { a, b, submit, deliver, server } = seeded();
    a.doc.state.items.move(0, 3);
    a.doc.state.items.set(3, "A");
    a.doc.state.items.move(3, 1);
    a.doc.state.items.delete(1);
    for (let index = 0; index < 4; index++) deliver(submit(a), a.doc, b.doc);
    assert.deepEqual(items(a.doc), ["b", "c", "d"]);
    assert.deepEqual(items(b.doc), ["b", "c", "d"]);
    assert.deepEqual(server.snapshot().data.items.values, ["b", "c", "d"]);
    assert.equal(server.snapshot().data.items.moves, undefined, "no moved element is visible");
  });

  it("emits a server change event for a peer's move, which changes only the order", () => {
    const { a, b, submit, deliver } = seeded();
    const origins: string[] = [];
    b.doc.on("change", (event) => origins.push(event.origin));
    a.doc.state.items.move(3, 0);
    deliver(submit(a), a.doc, b.doc);
    assert.deepEqual(origins, ["server"]);
    assert.deepEqual(items(b.doc), ["d", "a", "b", "c"]);
  });

  it("resolves concurrent moves of one element by server order, never duplicating it", () => {
    const { a, b, submit, deliver, server } = seeded();
    a.doc.state.items.move(0, 3);
    b.doc.state.items.move(0, 1);
    deliver(submit(a), a.doc, b.doc);
    assert.deepEqual(items(b.doc), ["b", "a", "c", "d"], "B's pending move replays over A's");
    deliver(submit(b), a.doc, b.doc);
    for (const doc of [a.doc, b.doc]) assert.deepEqual(items(doc), ["b", "a", "c", "d"], "the later move wins");
    assert.deepEqual(server.snapshot().data.items.values, ["b", "a", "c", "d"]);
  });

  it("applies a concurrent set to the moved element", () => {
    const { a, b, submit, deliver } = seeded();
    a.doc.state.items.move(1, 3);
    b.doc.state.items.set(1, "B!");
    deliver(submit(a), a.doc, b.doc);
    deliver(submit(b), a.doc, b.doc);
    for (const doc of [a.doc, b.doc]) assert.deepEqual(items(doc), ["a", "c", "d", "B!"]);
    assert.deepEqual(b.discards, []);
  });

  it("discards a move of an element another writer deleted, keeping its position usable as an anchor", () => {
    const { a, b, submit, deliver, server } = seeded();
    b.doc.state.items.delete(1);
    a.doc.transact(() => {
      a.doc.state.items.move(1, 3); // b to the end
      a.doc.state.items.insert(4, "after b"); // Anchored on b's new position.
    });
    deliver(submit(b), a.doc, b.doc);
    assert.deepEqual(items(a.doc), ["a", "c", "d", "after b"], "the replayed move is a no-op, the insert still lands");
    deliver(submit(a), a.doc, b.doc);
    assert.equal(a.discards.length, 1);
    assert.deepEqual(a.discards[0]!.operations.map(({ type }) => type), ["list/move"]);
    assert.deepEqual(b.discards, []);
    for (const doc of [a.doc, b.doc]) assert.deepEqual(items(doc), ["a", "c", "d", "after b"]);
    assert.deepEqual(server.snapshot().data.items.values, ["a", "c", "d", "after b"]);
  });

  it("deletes a moved element by its ID while a peer's move is pending", () => {
    const { a, b, submit, deliver } = seeded();
    a.doc.state.items.move(2, 0);
    b.doc.state.items.delete(2);
    deliver(submit(a), a.doc, b.doc);
    deliver(submit(b), a.doc, b.doc);
    for (const doc of [a.doc, b.doc]) assert.deepEqual(items(doc), ["a", "b", "d"]);
  });

  it("blocks replay on an unknown element, an unknown anchor or a reused position", () => {
    const { a, b, server, deliver } = seeded();
    // A moves its own pending insertion; the server then rejects that insertion.
    a.doc.state.items.push("x");
    a.doc.state.items.move(4, 0);
    const insert = a.batches.shift()!;
    deliver(server.reject(insert).commit, a.doc, b.doc);
    assert.match(a.doc.replayConflict?.message ?? "", /Unknown list element id/);
    assert.throws(() => a.doc.state.items.move(0, 1), /blocked/);
    deliver(server.reject(a.batches.shift()!).commit, a.doc, b.doc);
    assert.equal(a.doc.replayConflict, null);

    const id = a.doc.checkpoint().snapshot.data.items.idList[0]!;
    const clientId = b.doc.checkpoint().clientId;
    const element = { bunchId: id.bunchId, counter: 0 };
    const own = (counter: number) => ({ bunchId: JSON.stringify([clientId, "items", 99]), counter });
    for (const [message, operation] of [
      ["unknown anchor", { type: "list/move", path: "items", id: element, before: own(5), position: own(0) }],
      ["reused position", { type: "list/move", path: "items", id: element, before: null, position: element }],
      ["unknown element", { type: "list/move", path: "items", id: own(7), before: null, position: own(1) }],
    ] as const) {
      assert.throws(() => server.receive({ clientId, seq: 1, operations: [operation] }), Error, message);
    }
  });

  it("treats a visible move position as an unknown target, so it cannot detach a moved element", () => {
    const { a, b, server, submit, deliver } = seeded();
    a.doc.state.items.move(0, 2);
    const [move] = a.batches[0]!.operations;
    assert.ok(move?.type === "list/move");
    deliver(submit(a), a.doc, b.doc);
    const clientId = b.doc.checkpoint().clientId;
    const fresh = { bunchId: JSON.stringify([clientId, "items", 99]), counter: 0 };
    for (const operation of [
      { type: "list/set", path: "items", id: move.position, value: "X" },
      { type: "list/delete", path: "items", id: move.position },
      { type: "list/move", path: "items", id: move.position, before: null, position: fresh },
    ] as const) {
      assert.throws(() => server.receive({ clientId, seq: 1, operations: [operation] }), /Unknown list element id/, operation.type);
    }
    const { data } = server.snapshot();
    assert.deepEqual([data.items.values, data.items.moves], [["b", "c", "a", "d"], [{ id: move.id, position: move.position }]]);
    // Once the element moves on, its old position is a known tombstone: naming it is a no-op.
    a.doc.state.items.move(2, 0);
    deliver(submit(a), a.doc, b.doc);
    server.receive({ clientId, seq: 1, operations: [{ type: "list/set", path: "items", id: move.position, value: "X" }] });
    assert.deepEqual(server.snapshot().data.items.values, ["a", "b", "c", "d"]);
  });

  it("follows server transformation and rejection of a move", () => {
    let mode: "accept" | "reject" | "drop" = "accept";
    const { a, b, submit, deliver } = seeded((batch) => mode === "reject" ? [] :
      mode === "drop" ? batch.operations.filter(({ type }) => type !== "list/move") : batch.operations);
    a.doc.state.items.move(0, 3);
    mode = "reject";
    deliver(submit(a), a.doc, b.doc);
    assert.deepEqual(items(a.doc), ["a", "b", "c", "d"], "a rejected move restores the order");
    a.doc.transact(() => { a.doc.state.items.move(0, 3); a.doc.state.count.value = 1; });
    mode = "drop";
    deliver(submit(a), a.doc, b.doc);
    assert.deepEqual(items(a.doc), ["a", "b", "c", "d"]);
    assert.equal(a.doc.state.count.value, 1);
  });

  it("rolls back a failed transaction's move", () => {
    const { a } = seeded();
    const count = a.batches.length;
    assert.throws(() => a.doc.transact(() => { a.doc.state.items.move(0, 3); throw new Error("x"); }));
    assert.deepEqual(items(a.doc), ["a", "b", "c", "d"]);
    assert.equal(a.batches.length, count);
  });

  it("checks a move's new position against the writer's namespace and decodes moves strictly", () => {
    const { a } = seeded();
    a.doc.state.items.move(0, 2);
    const batch = a.batches.at(-1)!;
    assertClientBatchNamespace(batch, batch.clientId);
    const original = batch.operations[0];
    assert.ok(original?.type === "list/move");
    const forged = { ...batch, operations: [{ ...original,
      position: { bunchId: JSON.stringify(["client-99", "items", 1]), counter: original.position.counter } }] };
    assert.throws(() => assertClientBatchNamespace(decodeClientBatch(Board, json(forged)), batch.clientId), /position\/bunchId/);
    assert.deepEqual(decodeClientBatch(Board, json(batch)), batch);
    const move: Record<string, unknown> = { ...original };
    for (const broken of [
      { ...move, position: undefined }, { ...move, extra: 1 }, { ...move, path: "count" },
      { ...move, before: { bunchId: "", counter: 0 } }, Object.fromEntries(Object.entries(move).filter(([key]) => key !== "before")),
    ]) {
      assert.throws(() => decodeClientBatch(Board, { ...batch, operations: [broken] }), WireDecodeError, JSON.stringify(broken));
    }
  });

  it("saves moved elements in snapshots and checkpoints, and restores them", () => {
    const { a, b, server, submit, deliver } = seeded();
    a.doc.state.items.move(0, 3);
    deliver(submit(a), a.doc, b.doc);
    a.doc.state.items.move(1, 0); // Pending.
    const snapshot = server.snapshot();
    assert.equal(snapshot.data.items.moves?.length, 1);
    assert.deepEqual(decodeSnapshot(Board, json(snapshot)), snapshot);
    const fresh = createClient(Board, { clientId: server.openClient(), snapshot: decodeSnapshot(Board, json(snapshot)), onBatch() {} });
    assert.deepEqual(items(fresh), ["b", "c", "d", "a"]);
    fresh.state.items.set(3, "A");
    assert.equal(fresh.checkpoint().pendingBatches[0]!.operations[0]!.type, "list/set");

    const checkpoint = decodeClientCheckpoint(Board, json(a.doc.checkpoint()));
    const restored = createClient(Board, { clientId: checkpoint.clientId, checkpoint, onBatch() {} });
    assert.deepEqual(items(restored), ["c", "b", "d", "a"]);
    const restoredServer = createServer(Board, { checkpoint: decodeServerCheckpoint(Board, json(server.checkpoint())) });
    assert.deepEqual(restoredServer.snapshot().data.items.values, ["b", "c", "d", "a"]);
    restoredServer.receive(a.doc.checkpoint().pendingBatches[0]!);
    assert.deepEqual(restoredServer.snapshot().data.items.values, ["c", "b", "d", "a"]);

    const moved = snapshot.data.items.moves?.[0];
    assert.ok(moved !== undefined);
    const withMoves = (moves: unknown) => json({ ...snapshot, data: { ...snapshot.data, items: { ...snapshot.data.items, moves } } });
    for (const moves of [
      [{ id: moved.position, position: moved.position }],
      [{ id: moved.id, position: moved.id }],
      [moved, moved],
      [{ ...moved, extra: 1 }],
      "x",
    ]) assert.throws(() => decodeSnapshot(Board, withMoves(moves)), WireDecodeError, JSON.stringify(moves));
  });

  it("covers a pending move's position in the checkpoint's bunch counters", () => {
    const { b } = seeded(); // B allocated nothing before this move.
    b.doc.state.items.move(0, 2);
    const checkpoint = b.doc.checkpoint();
    assert.equal(checkpoint.lastBunchSeqs.items, 1);
    decodeClientCheckpoint(Board, json(checkpoint));
    const uncovered = { ...checkpoint, lastBunchSeqs: { ...checkpoint.lastBunchSeqs, items: 0 } };
    assert.throws(() => decodeClientCheckpoint(Board, json(uncovered)), /cover pending insert IDs/);
  });

  it("leaves a cursor bound to a moved element at its old gap", () => {
    const { a } = seeded();
    const cursor = a.doc.state.items.cursorAt(1, "right"); // Before b.
    a.doc.state.items.move(1, 3);
    assert.deepEqual(items(a.doc), ["a", "c", "d", "b"]);
    assert.equal(a.doc.state.items.cursorIndex(cursor), 1, "b's old gap, now before c");
  });
});
