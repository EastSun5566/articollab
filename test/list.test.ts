import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ListState } from "../src/list.ts";
import type { JsonValue } from "../src/schema.ts";

import {
  assertClientBatchNamespace,
  createClient,
  createServer,
  decodeClientBatch,
  decodeClientCheckpoint,
  decodeServerCheckpoint,
  decodeServerCommit,
  defineDocument,
  list,
  text,
  value,
  type ClientBatch,
  type DocumentOperation,
  type DocumentSnapshot,
  type ListInsertOperation,
} from "../src/index.ts";

const Board = defineDocument({
  title: value("Draft"),
  items: list<string>(),
});

type BoardOperation = DocumentOperation<typeof Board.definition>;
type BoardBatch = ClientBatch<BoardOperation>;

function setup(clientId = "client-1") {
  const batches: BoardBatch[] = [];
  const doc = createClient(Board, {
    clientId,
    onBatch: (batch) => batches.push(batch),
  });
  return { batches, doc };
}

describe("list runtime", () => {
  it("sets an existing value without changing identity or allocating IDs", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);
    doc.state.items.push("A");
    const before = doc.checkpoint();
    assert.equal(doc.state.items.set(0, "B"), undefined);
    doc.state.items.set(0, "B"); // An explicit same-value write is still a mutation.
    assert.deepEqual(doc.state.items.toArray(), ["B"]);
    assert.equal(doc.state.items.length, 1);
    assert.equal(changes, 3);
    assert.equal(batches.length, 3);
    const insertion = batches[0]!.operations[0]!;
    assert.equal(insertion.type, "list/insert");
    for (const batch of batches.slice(1)) {
      const operation = batch.operations[0]!;
      assert.equal(operation.type, "list/set");
      if (operation.type === "list/set" && insertion.type === "list/insert") {
        assert.deepEqual(operation.id, insertion.id);
        assert.notStrictEqual(operation.id, insertion.id);
        assert.ok(Object.isFrozen(operation) && Object.isFrozen(operation.id));
      }
    }
    assert.deepEqual(doc.checkpoint().lastBunchSeqs, before.lastBunchSeqs);
    assert.equal(doc.checkpoint().lastLocalSeq, 3);
  });

  it("validates set bounds and JSON before changing state, pending or notifications", () => {
    const schema = defineDocument({ items: list<JsonValue>() });
    let batches = 0, changes = 0, reads = 0;
    const doc = createClient(schema, { clientId: "json", onBatch: () => batches++ });
    doc.on("change", () => changes++);
    const payload = { nested: { valid: true } };
    doc.state.items.push(payload);
    const before = doc.checkpoint();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse: unknown[] = new Array<unknown>(2);
    sparse[1] = 1;
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => { reads++; return 1; } });
    for (const input of [undefined, NaN, Infinity, 1n, () => 1, Symbol(), cycle,
      new Date(), accessor, sparse, { bad: undefined }]) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid JSON verifies the public mutation validation boundary.
      assert.throws(() => doc.state.items.set(0, input as JsonValue), TypeError);
      assert.deepEqual(doc.checkpoint(), before);
    }
    for (const index of [-1, 1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => doc.state.items.set(index, "invalid index"));
      assert.deepEqual(doc.checkpoint(), before);
    }
    assert.equal(reads, 0);
    assert.strictEqual(doc.state.items.get(0), payload);
    assert.equal(batches, 1); assert.equal(changes, 1);
    const shared = { enabled: false };
    const valid = { left: shared, right: shared };
    doc.state.items.set(0, valid);
    assert.strictEqual(doc.state.items.get(0), valid);
    assert.equal(Object.isFrozen(valid), false);
    assert.equal(doc.checkpoint().lastLocalSeq, 2);
    assert.deepEqual(doc.checkpoint().lastBunchSeqs, before.lastBunchSeqs);
  });

  it("keeps persistent set versions isolated and treats known tombstones as no-ops", () => {
    const id = { bunchId: "seed", counter: 0 };
    const payload = { nested: true };
    const base = ListState.empty<JsonValue>().insert({ type: "list/insert", path: "items", before: null, id, value: payload });
    const operation = { type: "list/set", path: "items", id, value: payload } as const;
    assert.strictEqual(base.set(operation), base);
    const left = base.set({ ...operation, value: 0 });
    const right = base.set({ ...operation, value: null });
    const signed = left.set({ ...operation, value: -0 });
    assert.strictEqual(base.get(0), payload);
    assert.equal(left.get(0), 0); assert.equal(right.get(0), null);
    assert.ok(Object.is(signed.get(0), -0));
    assert.deepEqual(signed.save().idList, base.save().idList);
    const deleted = base.delete({ type: "list/delete", path: "items", id });
    assert.strictEqual(deleted.set({ ...operation, value: "no resurrection" }), deleted);
    assert.throws(() => base.set({ ...operation, id: { bunchId: "unknown", counter: 0 } }));
    assert.strictEqual(base.get(0), payload);
  });

  it("groups mixed sets and rolls back uncaught failures while retaining caught valid writes", () => {
    const { batches, doc } = setup();
    doc.state.items.push("A");
    const before = doc.checkpoint();
    let changes = 0;
    doc.on("change", () => changes++);
    assert.throws(() => doc.transact(() => {
      doc.state.title.set("rollback");
      doc.state.items.set(0, "B");
      doc.state.items.set(1, "out of bounds");
    }));
    assert.deepEqual(doc.checkpoint(), before);
    assert.deepEqual(doc.state.items.toArray(), ["A"]);
    assert.equal(changes, 0);
    doc.transact(() => {
      doc.state.title.set("updated");
      doc.state.items.set(0, "B");
      assert.throws(() => doc.state.items.set(0, NaN as unknown as string), TypeError); // oxlint-disable-line typescript/no-unsafe-type-assertion -- Invalid JSON must not enter the mixed transaction.
      doc.state.items.set(0, "C");
    });
    assert.equal(batches.length, 2);
    assert.equal(changes, 1);
    assert.deepEqual(batches[1]!.operations.map((operation) => operation.type), ["value/set", "list/set", "list/set"]);
    assert.deepEqual(doc.state.items.toArray(), ["C"]);
    assert.deepEqual(doc.checkpoint().lastBunchSeqs, before.lastBunchSeqs);
  });

  it("orders concurrent sets on one stable ID and replays against identity rather than index", () => {
    for (const reversed of [false, true]) {
      const server = createServer(Board);
      const a = setup(server.openClient()), b = setup(server.openClient());
      a.doc.state.items.push("A");
      const initial = server.receive(a.batches[0]!).commit;
      a.doc.receive(initial); b.doc.receive(initial);
      const ids = server.snapshot().data.items.idList;
      a.doc.state.items.set(0, "from A"); b.doc.state.items.set(0, "from B");
      assertClientBatchNamespace(b.batches[0]!, b.doc.checkpoint().clientId); // Updating the other writer's element is not ID allocation.
      const first = server.receive(reversed ? b.batches[0]! : a.batches[1]!).commit;
      a.doc.receive(first); b.doc.receive(first);
      const second = server.receive(reversed ? a.batches[1]! : b.batches[0]!).commit;
      a.doc.receive(second); b.doc.receive(second);
      assert.deepEqual(server.snapshot().data.items.idList, ids);
      assert.deepEqual(a.doc.state.items.toArray(), [reversed ? "from A" : "from B"]);
      assert.deepEqual(b.doc.state.items.toArray(), a.doc.state.items.toArray());
      a.doc.state.items.set(0, "pending update");
      b.doc.state.items.insert(0, "new first");
      const insertion = server.receive(b.batches[1]!).commit;
      a.doc.receive(insertion); b.doc.receive(insertion);
      assert.deepEqual(a.doc.state.items.toArray(), ["new first", "pending update"]);
      const update = server.receive(a.batches[2]!).commit;
      a.doc.receive(update); b.doc.receive(update);
      assert.deepEqual(a.doc.checkpoint().snapshot, server.snapshot());
      assert.deepEqual(b.doc.checkpoint().snapshot, server.snapshot());
    }
  });

  it("lets deletion win over set in either server order without blocking other batch operations", () => {
    for (const deleteFirst of [false, true]) {
      const server = createServer(Board);
      const a = setup(server.openClient()), b = setup(server.openClient());
      a.doc.state.items.push("A");
      const initial = server.receive(a.batches[0]!).commit;
      a.doc.receive(initial); b.doc.receive(initial);
      a.doc.transact(() => { a.doc.state.items.set(0, "updated"); a.doc.state.title.set("still applies"); });
      b.doc.state.items.delete(0);
      const first = server.receive(deleteFirst ? b.batches[0]! : a.batches[1]!).commit;
      a.doc.receive(first); b.doc.receive(first);
      assert.equal(a.doc.replayConflict, null);
      if (deleteFirst) assert.deepEqual(a.doc.state.items.toArray(), []);
      const second = server.receive(deleteFirst ? a.batches[1]! : b.batches[0]!).commit;
      a.doc.receive(second); b.doc.receive(second);
      assert.deepEqual(a.doc.state.items.toArray(), []);
      assert.equal(a.doc.state.title.value, "still applies");
      assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
      assert.deepEqual(a.doc.checkpoint().snapshot, server.snapshot());
      assert.deepEqual(b.doc.checkpoint().snapshot, server.snapshot());
    }
  });

  it("rejects unknown set targets atomically and keeps rejected insertion dependencies blocked", () => {
    const server = createServer(Board);
    const { batches, doc } = setup(server.openClient());
    const before = server.checkpoint();
    assert.throws(() => server.receive({ clientId: doc.checkpoint().clientId, seq: 1,
      operations: [{ type: "value/set", path: "title", value: "must rollback" },
        { type: "list/set", path: "items", id: { bunchId: "unknown", counter: 0 }, value: "B" }],
    }));
    assert.deepEqual(server.checkpoint(), before);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A set on a Value path must retain atomic collection-kind validation at the typed boundary.
    const wrongKind = { type: "list/set", path: "title", id: { bunchId: "unknown", counter: 0 }, value: "B" } as unknown as BoardOperation;
    assert.throws(() => server.receive({ clientId: doc.checkpoint().clientId, seq: 1, operations: [wrongKind] }));
    assert.deepEqual(server.checkpoint(), before);
    doc.state.items.push("A");
    doc.state.items.set(0, "dependent");
    doc.receive(server.reject(batches[0]!).commit);
    assert.strictEqual(doc.replayConflict?.batch, batches[1]);
    assert.equal(doc.replayConflict?.operationIndex, 0);
    assert.deepEqual(doc.state.items.toArray(), []);
    const restored = createClient(Board, { clientId: before.clients[0]!.clientId,
      checkpoint: decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(doc.checkpoint()))), onBatch() {} });
    assert.notEqual(restored.replayConflict, null);
    restored.receive(server.reject(batches[1]!).commit);
    assert.equal(restored.replayConflict, null);
    assert.deepEqual(restored.checkpoint().pendingBatches, []);
  });

  it("round-trips set policy results, retry history and pending checkpoints without new IDs", () => {
    let decision: "accept" | "reject" | "transform" = "accept";
    let calls = 0;
    const resolve = ({ batch }: { batch: BoardBatch }) => {
      calls++;
      if (decision === "reject") return [];
      return batch.operations.map((operation) => decision === "transform" && operation.type === "list/set"
        ? { ...operation, value: "server:" + operation.value } : operation);
    };
    let server = createServer(Board, { resolve });
    const { batches, doc } = setup(server.openClient());
    doc.state.items.push("A");
    doc.receive(server.receive(batches[0]!).commit);
    const allocations = doc.checkpoint().lastBunchSeqs;
    for (const mode of ["reject", "transform"] as const) {
      decision = mode;
      doc.state.items.set(0, "B");
      const batch = batches.at(-1)!;
      doc.receive(decodeServerCommit(Board, JSON.parse(JSON.stringify(server.receive(decodeClientBatch(Board,
        JSON.parse(JSON.stringify(batch)))).commit))));
      assert.equal(doc.state.items.get(0), mode === "reject" ? "A" : "server:B");
    }
    doc.state.items.set(0, "pending");
    let restored = createClient(Board, { clientId: doc.checkpoint().clientId,
      checkpoint: decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(doc.checkpoint()))), onBatch() {} });
    server = createServer(Board, { resolve, checkpoint: decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(server.checkpoint()))) });
    const previousCalls = calls;
    assert.equal(server.receive(batches[2]!).replayed, true);
    assert.equal(calls, previousCalls);
    const commit = server.receive(restored.checkpoint().pendingBatches[0]!).commit;
    // Simulate a lost ack, then restore both sides and catch up without resolving twice.
    restored = createClient(Board, { clientId: restored.checkpoint().clientId,
      checkpoint: decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(restored.checkpoint()))), onBatch() {} });
    server = createServer(Board, { resolve, checkpoint: decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(server.checkpoint()))) });
    const afterCommit = calls;
    for (const missed of server.commitsSince(restored.checkpoint().snapshot.serverSeq)!) restored.receive(missed);
    assert.equal(restored.state.items.get(0), "server:pending");
    assert.deepEqual(restored.checkpoint().pendingBatches, []);
    assert.deepEqual(restored.checkpoint().lastBunchSeqs, allocations);
    assert.equal(server.reject(batches[3]!).replayed, true);
    assert.equal(calls, afterCommit);
    assert.equal(restored.checkpoint().snapshot.serverSeq, commit.serverSeq);
  });

  it("batches Value/List/Text updates and rolls all three back on set validation failure", () => {
    const schema = defineDocument({ count: value(0), items: list<JsonValue>(), body: text() });
    const batches: ClientBatch<DocumentOperation<typeof schema.definition>>[] = [];
    const doc = createClient(schema, { clientId: "mixed", onBatch: (batch) => batches.push(batch) });
    doc.state.items.push("seed");
    const before = doc.checkpoint();
    assert.throws(() => doc.transact(() => {
      doc.state.count.set(1); doc.state.items.set(0, "rollback"); doc.state.body.insert(0, "😀");
      doc.state.items.set(0, NaN);
    }), TypeError);
    // The failed transaction keeps allocated Text IDs, but set itself allocates nothing.
    assert.deepEqual(doc.checkpoint(), { ...before, lastBunchSeqs: { items: 1, body: 1 } });
    assert.equal(doc.state.count.value, 0); assert.equal(doc.state.body.toString(), "");
    assert.deepEqual(doc.state.items.toArray(), ["seed"]);
    let changes = 0;
    doc.on("change", () => changes++);
    doc.transact(() => {
      doc.state.count.set(1); doc.state.items.set(0, "updated"); doc.state.body.insert(0, "😀");
    });
    assert.equal(changes, 1);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[1]!.operations.map((operation) => operation.type), ["value/set", "list/set", "text/insert"]);
  });

  it("rejects non-JSON insert/push before allocating IDs or producing a batch", () => {
    const schema = defineDocument({ items: list<JsonValue>() });
    let batches = 0;
    let changes = 0;
    let reads = 0;
    const getter = () => { reads++; return 1; };
    const doc = createClient(schema, { clientId: "json", onBatch: () => batches++ });
    doc.on("change", () => changes++);
    const before = doc.checkpoint();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const input of [undefined, NaN, Infinity, -Infinity, 1n, () => {}, Symbol(), new Date(), cycle,
      { nested: undefined }, new Array<unknown>(1), { [Symbol()]: 1 },
      Object.assign([0], { extra: 1 }), Object.defineProperty({}, "hidden", { value: 1 }),
      Object.defineProperty({}, "bad/~", { get: getter, enumerable: true }),
      Object.defineProperty([0], "0", { get: getter, enumerable: true }),
      { toJSON: () => { reads++; return 1; } }]) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid local payloads verify the runtime boundary beyond TS.
      const payload = input as JsonValue;
      assert.throws(() => doc.state.items.insert(0, payload), TypeError);
      assert.throws(() => doc.state.items.push(payload), TypeError);
      assert.equal(doc.state.items.length, 0);
      assert.deepEqual(doc.checkpoint(), before);
    }
    assert.equal(reads, 0);
    assert.equal(batches, 0);
    assert.equal(changes, 0);
    doc.state.items.push("valid");
    const operation = doc.checkpoint().pendingBatches[0]!.operations[0]!;
    assert.equal(operation.type, "list/insert");
    if (operation.type !== "list/insert") return;
    assert.equal(operation.id.bunchId, JSON.stringify(["json", "items", 1]));
    assert.equal(operation.id.counter, 0);
    assert.equal(doc.checkpoint().lastLocalSeq, 1);
    assert.equal(batches, 1);
    assert.equal(changes, 1);
  });

  it("keeps legal list payloads shared and accepts deep JSON without freezing it", () => {
    const schema = defineDocument({ items: list<JsonValue>() });
    const doc = createClient(schema, { clientId: "refs", onBatch() {} });
    const dictionary: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Null-prototype JSON fixture with only ordinary string data properties.
    dictionary.value = false;
    const shared = { nested: [1] };
    const payload = { dictionary, left: shared, right: shared, ["__proto__"]: { safe: true } };
    doc.state.items.push(payload);
    assert.strictEqual(doc.state.items.get(0), payload);
    assert.strictEqual(doc.state.items.toArray()[0], payload);
    for (const object of [payload, dictionary, shared, shared.nested, payload.__proto__]) {
      assert.equal(Object.isFrozen(object), false);
    }
    for (const primitive of [null, false, "", 0, -0, 1.5]) {
      doc.state.items.push(primitive);
      assert.ok(Object.is(doc.state.items.get(doc.state.items.length - 1), primitive));
    }
    const deep: JsonValue = JSON.parse('[{"next":'.repeat(10_000) + '0' + '}]'.repeat(10_000)) as JsonValue; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Only valid JSON tokens are used in this deep fixture.
    doc.state.items.insert(0, deep);
    assert.strictEqual(doc.state.items.get(0), deep);
    assert.equal(Object.isFrozen(deep), false);
  });

  it("isolates persistent branches and snapshots while preserving JSON payload references", () => {
    const payload = { nested: { value: 1 } };
    const base = ListState.empty<JsonValue>().insert({ type: "list/insert", path: "items",
      before: null, id: { bunchId: "base", counter: 0 }, value: payload });
    const saved = base.save();
    const left = base.insert({ type: "list/insert", path: "items",
      before: { bunchId: "base", counter: 0 }, id: { bunchId: "left", counter: 0 }, value: null });
    const right = base.insert({ type: "list/insert", path: "items",
      before: null, id: { bunchId: "right", counter: 0 }, value: -0 });
    const deleted = left.delete({ type: "list/delete", path: "items", id: { bunchId: "base", counter: 0 } });
    assert.deepEqual(base.toArray(), [payload]);
    assert.strictEqual(base.get(0), payload);
    assert.strictEqual(left.get(0), payload);
    assert.deepEqual(left.toArray(), [payload, null]);
    assert.ok(Object.is(right.get(0), -0));
    assert.strictEqual(right.get(1), payload);
    assert.deepEqual(deleted.toArray(), [null]);
    assert.deepEqual(base.save(), saved);
    const restored = ListState.load(right.save());
    assert.ok(Object.is(restored.get(0), -0));
    assert.strictEqual(restored.get(1), payload);
    assert.ok(right.visibleEquals(restored));
    assert.throws(() => base.insert({ type: "list/insert", path: "items", before: null,
      id: { bunchId: "base", counter: 0 }, value: "collision" }));
    assert.deepEqual(base.save(), saved);
  });

  it("provides typed optimistic list operations and validates indexes", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);

    doc.state.items.push("b");
    doc.state.items.insert(0, "a");
    doc.state.items.delete(1);

    const first: string = doc.state.items.get(0);
    assert.equal(first, "a");
    assert.equal(doc.state.items.length, 1);
    assert.deepEqual(doc.state.items.toArray(), ["a"]);
    assert.deepEqual([...doc.state.items.values()], ["a"]);
    assert.deepEqual([...doc.state.items], ["a"]);
    assert.deepEqual(
      batches.map((batch) => batch.operations[0]?.type),
      ["list/insert", "list/insert", "list/delete"]
    );
    assert.equal(changes, 3);

    const firstOperation = batches[0]!.operations[0];
    assert.equal(firstOperation?.type, "list/insert");
    if (firstOperation?.type === "list/insert") {
      assert.ok(Object.isFrozen(firstOperation));
      assert.ok(Object.isFrozen(firstOperation.id));
    }

    assert.throws(() => doc.state.items.get(1), /out of bounds/i);
    assert.throws(() => doc.state.items.insert(2, "x"), /out of bounds/i);
    assert.throws(() => doc.state.items.delete(1), /out of bounds/i);
    assert.equal(batches.length, 3);
    assert.equal(changes, 3);
    assert.deepEqual(doc.state.items.toArray(), ["a"]);
  });

  it("groups mixed collections and rolls back a failed transaction", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);

    doc.transact(() => {
      doc.state.title.value = "Ready";
      doc.state.items.push("a");
      doc.state.items.insert(0, "b");
    });

    assert.equal(batches.length, 1);
    assert.deepEqual(
      batches[0]!.operations.map((operation) => operation.type),
      ["value/set", "list/insert", "list/insert"]
    );
    assert.equal(changes, 1);
    assert.equal(doc.state.title.value, "Ready");
    assert.deepEqual(doc.state.items.toArray(), ["b", "a"]);

    assert.throws(() => {
      doc.transact(() => {
        doc.state.title.value = "Broken";
        doc.state.items.delete(0);
        throw new Error("stop");
      });
    }, /stop/);

    assert.equal(batches.length, 1);
    assert.equal(changes, 1);
    assert.equal(doc.state.title.value, "Ready");
    assert.deepEqual(doc.state.items.toArray(), ["b", "a"]);
  });

  it("acknowledges and rejects optimistic list mutations", () => {
    const { batches, doc } = setup();
    const serverChanges: string[][] = [];
    doc.on("change", (event) => {
      if (event.origin === "server") {
        serverChanges.push(doc.state.items.toArray());
      }
    });

    doc.state.items.push("a");
    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-1", seq: 1 },
      operations: batches[0]!.operations,
    });
    assert.deepEqual(serverChanges, []);

    doc.state.items.push("b");
    doc.receive({
      serverSeq: 2,
      source: { clientId: "client-1", seq: 2 },
      operations: [],
    });
    assert.deepEqual(doc.state.items.toArray(), ["a"]);

    doc.state.items.delete(0);
    doc.receive({
      serverSeq: 3,
      source: { clientId: "client-1", seq: 3 },
      operations: [],
    });
    assert.deepEqual(doc.state.items.toArray(), ["a"]);
    assert.deepEqual(serverChanges, [["a"], ["a"]]);
  });

  it("replays an insertion after a deleted anchor and hydrates its tombstone", () => {
    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    assert.equal(server.openClient(), "client-3");
    const client1Batches: BoardBatch[] = [];
    const client2Batches: BoardBatch[] = [];
    const client1 = createClient(Board, {
      clientId: "client-1",
      onBatch: (batch) => client1Batches.push(batch),
    });
    const client2 = createClient(Board, {
      clientId: "client-2",
      onBatch: (batch) => client2Batches.push(batch),
    });

    client1.state.items.push("base");
    const baseCommit = server.receive(client1Batches[0]!).commit;
    client1.receive(baseCommit);
    client2.receive(baseCommit);

    client1.state.items.push("after");
    client2.state.items.delete(0);

    const deleteCommit = server.receive(client2Batches[0]!).commit;
    client1.receive(deleteCommit);
    client2.receive(deleteCommit);
    assert.deepEqual(client1.state.items.toArray(), ["after"]);
    assert.deepEqual(client2.state.items.toArray(), []);

    const snapshot = server.snapshot();
    const lateClient = createClient(Board, {
      clientId: "client-3",
      snapshot,
      onBatch: () => {},
    });
    assert.deepEqual(lateClient.state.items.toArray(), []);
    assert.equal(snapshot.data.items.idList[0]?.isDeleted, true);

    const insertCommit = server.receive(client1Batches[1]!).commit;
    client1.receive(insertCommit);
    client2.receive(insertCommit);
    lateClient.receive(insertCommit);

    assert.equal(insertCommit.serverSeq, 3);
    assert.deepEqual(client1.state.items.toArray(), ["after"]);
    assert.deepEqual(client2.state.items.toArray(), ["after"]);
    assert.deepEqual(lateClient.state.items.toArray(), ["after"]);
  });

  it("freezes and validates list snapshot data", () => {
    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const { batches, doc } = setup();
    doc.state.items.push("a");
    const commit = server.receive(batches[0]!).commit;
    doc.receive(commit);

    const snapshot = server.snapshot();
    assert.deepEqual(snapshot.data.items.values, ["a"]);
    assert.ok(Object.isFrozen(snapshot.data.items));
    assert.ok(Object.isFrozen(snapshot.data.items.idList));
    assert.ok(Object.isFrozen(snapshot.data.items.idList[0]));
    assert.ok(Object.isFrozen(snapshot.data.items.values));

    const invalidSnapshot = {
      ...snapshot,
      data: {
        ...snapshot.data,
        items: { ...snapshot.data.items, values: [] },
      },
    } as DocumentSnapshot<typeof Board.definition>;
    assert.throws(
      () =>
        createClient(Board, {
          clientId: "client-2",
          snapshot: invalidSnapshot,
          onBatch: () => {},
        }),
      /present ids but 0 values/
    );
  });

  it("rejects invalid server list operations atomically", () => {
    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    assert.equal(server.openClient(), "client-3");
    assert.equal(server.openClient(), "client-4");
    const id1 = { bunchId: JSON.stringify(["client-1", "items", 1]), counter: 0 };
    const id2 = { bunchId: JSON.stringify(["client-2", "items", 1]), counter: 0 };
    const missing = { bunchId: "missing", counter: 0 };
    const receive = (
      clientId: string,
      seq: number,
      operations: readonly BoardOperation[]
    ) => server.receive({ clientId, seq, operations }).commit;

    const wrongKind = {
      type: "list/insert",
      path: "title",
      before: null,
      id: { bunchId: JSON.stringify(["client-4", "title", 1]), counter: 0 },
      value: "x",
    } as unknown as BoardOperation; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
    assert.throws(
      () => receive("client-4", 1, [wrongKind]),
      /does not match document path/
    );

    assert.throws(
      () =>
        receive("client-1", 1, [
          {
            type: "list/insert",
            path: "items",
            before: missing,
            id: id1,
            value: "a",
          },
        ]),
      /Unknown list insertion anchor/
    );

    const firstCommit = receive("client-1", 1, [
      {
        type: "list/insert",
        path: "items",
        before: null,
        id: id1,
        value: "a",
      },
    ]);
    assert.equal(firstCommit.serverSeq, 1);

    assert.throws(
      () =>
        receive("client-1", 2, [
          {
            type: "list/insert",
            path: "items",
            before: null,
            id: id1,
            value: "duplicate",
          },
        ]),
      /Duplicate list element id/
    );
    assert.throws(
      () =>
        receive("client-2", 1, [
          { type: "list/delete", path: "items", id: missing },
        ]),
      /Unknown list element id/
    );

    const mutableOperation: ListInsertOperation<"items", string> = {
      type: "list/insert",
      path: "items",
      before: null,
      id: id2,
      value: "b",
    };
    const secondCommit = receive("client-2", 1, [mutableOperation]);
    id2.counter = 99;

    assert.equal(secondCommit.serverSeq, 2);
    const accepted = secondCommit.operations[0];
    assert.equal(accepted?.type, "list/insert");
    if (accepted?.type === "list/insert") {
      assert.equal(accepted.id.counter, 0);
      assert.ok(Object.isFrozen(accepted.id));
    }

    const deleteCommit = receive("client-1", 2, [
      { type: "list/delete", path: "items", id: id1 },
    ]);
    const repeatedDelete = receive("client-3", 1, [
      { type: "list/delete", path: "items", id: id1 },
    ]);
    assert.equal(deleteCommit.serverSeq, 3);
    assert.equal(repeatedDelete.serverSeq, 4);
  });

  it("resolves list rejection and mixed transaction transformation end to end", () => {
    type Decision = "accept" | "reject" | "title-only";
    let decision: Decision = "accept";
    const server = createServer(Board, {
      resolve: ({ batch, snapshot }) => {
        const itemCount: number = snapshot.data.items.values.length;
        assert.ok(itemCount >= 0);
        if (decision === "reject") return [];
        if (decision === "title-only") {
          return batch.operations.filter(
            (operation) => operation.type === "value/set"
          );
        }
        return batch.operations;
      },
    });
    assert.equal(server.openClient(), "client-1");
    const { batches, doc } = setup();

    doc.state.items.push("base");
    doc.receive(server.receive(batches[0]!).commit);
    assert.deepEqual(doc.state.items.toArray(), ["base"]);

    decision = "reject";
    doc.state.items.push("rejected");
    const rejectedInsert = server.receive(batches[1]!).commit;
    doc.receive(rejectedInsert);
    assert.deepEqual(rejectedInsert.operations, []);
    assert.deepEqual(doc.state.items.toArray(), ["base"]);

    doc.state.items.delete(0);
    const rejectedDelete = server.receive(batches[2]!).commit;
    doc.receive(rejectedDelete);
    assert.deepEqual(rejectedDelete.operations, []);
    assert.deepEqual(doc.state.items.toArray(), ["base"]);

    decision = "title-only";
    doc.transact(() => {
      doc.state.title.value = "Ready";
      doc.state.items.push("omitted");
    });
    const transformed = server.receive(batches[3]!).commit;
    doc.receive(transformed);

    assert.deepEqual(
      transformed.operations.map((operation) => operation.type),
      ["value/set"]
    );
    assert.equal(doc.state.title.value, "Ready");
    assert.deepEqual(doc.state.items.toArray(), ["base"]);
    assert.equal(server.snapshot().serverSeq, 4);
  });

  it("validates transformed list operations before consuming sequences", () => {
    let returnWrongKind = true;
    const server = createServer(Board, {
      resolve: ({ batch }) => {
        if (!returnWrongKind) return batch.operations;
        return [
          {
            type: "list/insert",
            path: "title",
            before: null,
            id: { bunchId: "policy", counter: 0 },
            value: "invalid",
          },
        ] as unknown as readonly BoardOperation[]; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
      },
    });
    assert.equal(server.openClient(), "client-1");
    const batch: BoardBatch = {
      clientId: "client-1",
      seq: 1,
      operations: [{ type: "value/set", path: "title", value: "Ready" }],
    };

    assert.throws(
      () => server.receive(batch),
      /does not match document path/
    );
    assert.equal(server.snapshot().serverSeq, 0);

    returnWrongKind = false;
    const commit = server.receive(batch).commit;
    assert.equal(commit.serverSeq, 1);
    assert.equal(server.snapshot().data.title, "Ready");
  });
});
