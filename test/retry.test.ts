import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient,
  createServer,
  decodeClientBatch,
  decodeServerCheckpoint,
  defineDocument,
  list,
  text,
  value as valueSchema,
  type ClientBatch,
  type DocumentOperation,
  type JsonValue,
  type ServerReceipt,
} from "../src/index.ts";

const Board = defineDocument({
  count: valueSchema(0),
  items: list<string>(),
  body: text(),
});
type BoardOperation = DocumentOperation<typeof Board.definition>;
type BoardBatch = ClientBatch<BoardOperation>;

const makeBatch = (clientId: string, seq: number, count: number): BoardBatch => ({
  clientId,
  seq,
  operations: [{ type: "value/set", path: "count", value: count }],
});

describe("server retry", () => {
  it("routes a missed reply only to its sender without running policy twice", () => {
    let calls = 0;
    const server = createServer(Board, {
      resolve: ({ batch }) => {
        calls++;
        return batch.operations;
      },
    });
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const batches: BoardBatch[] = [];
    const sender = createClient(Board, {
      clientId: "client-1",
      onBatch: (batch) => batches.push(batch),
    });
    const peer = createClient(Board, { clientId: "client-2", onBatch: () => {} });
    sender.state.count.value = 1;
    const first: ServerReceipt<BoardOperation> = server.receive(batches[0]!);
    assert.equal(first.replayed, false);
    assert.ok(Object.isFrozen(first));
    peer.receive(first.commit); // Sender misses the broadcast.
    const before = server.checkpoint();

    const retry = server.receive(
      decodeClientBatch(Board, JSON.parse(JSON.stringify(batches[0])))
    );
    assert.equal(retry.replayed, true);
    assert.ok(Object.isFrozen(retry));
    assert.strictEqual(retry.commit, first.commit);
    assert.equal(calls, 1);
    assert.deepEqual(server.checkpoint(), before);
    sender.receive(retry.commit); // Do not broadcast the old sequence to peer.

    sender.state.count.value = 2;
    const next = server.receive(batches[1]!);
    assert.equal(next.replayed, false);
    assert.equal(next.commit.serverSeq, 2);
    sender.receive(next.commit);
    peer.receive(next.commit);
    assert.equal(sender.state.count.value, 2);
    assert.equal(peer.state.count.value, 2);
  });

  it("replays mixed accepted, rejected, and transformed batches after restore", () => {
    for (const mode of ["accept", "reject", "transform"] as const) {
      const server = createServer(Board, {
        resolve: ({ batch }) => {
          if (mode === "reject") return [];
          return batch.operations.map((operation) => {
            if (mode !== "transform") return operation;
            if (operation.type === "value/set") return { ...operation, value: 5 };
            if (operation.type === "text/insert") return { ...operation, value: "HI 😀" };
            return operation;
          });
        },
      });
      const batches: BoardBatch[] = [];
      const doc = createClient(Board, {
        clientId: server.openClient(),
        onBatch: (batch) => batches.push(batch),
      });
      doc.transact(() => {
        doc.state.count.value = 10;
        doc.state.items.push("todo");
        doc.state.body.insert(0, "Hi 😀");
      });
      const first = server.receive(batches[0]!);
      const checkpoint = decodeServerCheckpoint(
        Board,
        JSON.parse(JSON.stringify(server.checkpoint()))
      );
      const restored = createServer(Board, {
        checkpoint,
        resolve: () => {
          throw new Error("replay must not call the new policy");
        },
      });
      const retry = restored.receive(
        decodeClientBatch(Board, JSON.parse(JSON.stringify(batches[0])))
      );
      assert.equal(retry.replayed, true);
      assert.deepEqual(retry.commit, first.commit);
      assert.deepEqual(restored.snapshot(), server.snapshot());
      doc.receive(retry.commit);
      const expectedCount = mode === "reject" ? 0 : mode === "transform" ? 5 : 10;
      assert.equal(doc.state.count.value, expectedCount);
      assert.deepEqual(doc.state.items.toArray(), mode === "reject" ? [] : ["todo"]);
      assert.equal(
        doc.state.body.toString(),
        mode === "reject" ? "" : mode === "transform" ? "HI 😀" : "Hi 😀"
      );
    }
  });

  it("retains only the last batch per client and rejects stale or conflicting retries", () => {
    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    assert.equal(server.openClient(), "client-3");
    const first = server.receive(makeBatch("client-1", 1, 1));
    server.receive(makeBatch("client-2", 1, 2));
    assert.strictEqual(server.receive(makeBatch("client-1", 1, 1)).commit, first.commit);
    const checkpoint = server.checkpoint();
    for (const invalid of [makeBatch("client-1", 1, 9), makeBatch("client-1", 3, 3), makeBatch("client-3", 2, 4)]) {
      assert.throws(() => server.receive(invalid));
      assert.deepEqual(server.checkpoint(), checkpoint);
    }
    const second = server.receive(makeBatch("client-1", 2, 3));
    assert.equal(second.commit.serverSeq, 3);
    assert.equal(server.checkpoint().clients.length, 3);
    assert.throws(() => server.receive(makeBatch("client-1", 1, 1)), /Expected client sequence 3/);
    assert.strictEqual(server.receive(makeBatch("client-1", 2, 3)).commit, second.commit);
    assert.deepEqual(checkpoint.snapshot.data.count, 2); // Previous checkpoint stays unchanged.
    assert.equal(checkpoint.clients.find((entry) => entry.clientId === "client-1")!.replay!.batch.seq, 1);
    assert.equal(server.receive(makeBatch("client-3", 1, 4)).commit.serverSeq, 4);
    assert.equal(server.openClient(), "client-4");
    const ordered = {
      ...makeBatch("client-4", 1, 1),
      operations: [...makeBatch("client-4", 1, 1).operations, ...makeBatch("client-4", 1, 2).operations],
    };
    server.receive(ordered);
    assert.throws(
      () => server.receive({ ...ordered, operations: [...ordered.operations].reverse() }),
      /Retry batch differs/
    );
  });

  it("keeps the previous replay when policy, application, or reentrancy fails", () => {
    let mode: "accept" | "throw" | "invalid" | "reentrant" = "accept";
    const firstBatch = makeBatch("client-1", 1, 1);
    const server = createServer(Board, {
      resolve: ({ batch }) => {
        if (mode === "throw") throw new Error("policy failed");
        if (mode === "invalid") {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
          return [{ type: "value/set", path: "missing", value: 2 }] as unknown as BoardOperation[];
        }
        if (mode === "reentrant") server.receive(firstBatch);
        return batch.operations;
      },
    });
    assert.equal(server.openClient(), "client-1");
    const first = server.receive(firstBatch);
    const checkpoint = server.checkpoint();
    for (const failure of ["throw", "invalid", "reentrant"] as const) {
      mode = failure;
      assert.throws(() => server.receive(makeBatch("client-1", 2, 2)));
      assert.deepEqual(server.checkpoint(), checkpoint);
      assert.strictEqual(server.receive(firstBatch).commit, first.commit);
    }
    mode = "accept";
    assert.equal(server.receive(makeBatch("client-1", 2, 2)).commit.serverSeq, 2);
  });

  it("compares nested JSON without depending on object key order", () => {
    const Data = defineDocument({
      data: valueSchema<{ a: number[]; b: { enabled: boolean } }>({
        a: [1, 2], b: { enabled: true },
      }),
    });
    const server = createServer(Data);
    assert.equal(server.openClient(), "client-1");
    const operation = {
      type: "value/set" as const,
      path: "data" as const,
      value: { a: [1, 2], b: { enabled: true } },
    };
    const input = { clientId: "client-1", seq: 1, operations: [operation] };
    const first = server.receive(input);
    operation.value = { a: [9], b: { enabled: false } }; // Library owns operation containers.
    input.operations.length = 0;
    const retry = {
      clientId: "client-1", seq: 1,
      operations: [{
        type: "value/set" as const,
        path: "data" as const,
        value: { b: { enabled: true }, a: [1, 2] },
      }],
    };
    assert.strictEqual(server.receive(retry).commit, first.commit);
    assert.throws(
      () => server.receive({
        ...retry,
        operations: [{ ...retry.operations[0]!, value: { b: { enabled: true }, a: [2, 1] } }],
      }),
      /Retry batch differs/
    );
    assert.deepEqual(server.snapshot().data.data, { a: [1, 2], b: { enabled: true } });
    assert.ok(Object.isFrozen(server.checkpoint().clients[0]!.replay));
    assert.ok(Object.isFrozen(server.checkpoint().clients[0]!.replay!.batch.operations));
  });

  it("retries and restores 20,000-level JSON while comparing the deepest payload", () => {
    const Data = defineDocument({ data: valueSchema<JsonValue>(null) });
    const depth = 20_000;
    const makeDeepBatch = (leaf: JsonValue) => {
      let nested = leaf;
      for (let index = 0; index < depth; index++) nested = [nested];
      return {
        clientId: "client-1", seq: 1,
        operations: [{ type: "value/set" as const, path: "data" as const, value: nested }],
      };
    };
    const server = createServer(Data);
    assert.equal(server.openClient(), "client-1");
    const first = server.receive(makeDeepBatch({ a: 1, b: [true, null] }));
    const checkpoint = server.checkpoint();
    const same = makeDeepBatch({ b: [true, null], a: 1 });
    assert.strictEqual(server.receive(same).commit, first.commit);
    const changed = makeDeepBatch({ b: [true, null], a: 2 });
    assert.throws(() => server.receive(changed), /Retry batch differs/);
    assert.strictEqual(server.checkpoint().clients[0]!.replay, checkpoint.clients[0]!.replay);
    assert.equal(server.snapshot().serverSeq, 1);

    const decoded = decodeServerCheckpoint(Data, checkpoint);
    const restored = createServer(Data, { checkpoint: decoded });
    const retry = restored.receive(decodeClientBatch(Data, same));
    assert.equal(retry.replayed, true);
    assert.equal(retry.commit.serverSeq, 1);
    assert.throws(() => restored.receive(changed), /Retry batch differs/);
    assert.equal(restored.snapshot().serverSeq, 1);
    assert.equal(restored.checkpoint().history.length, 1);
    let payload: unknown = restored.snapshot().data.data;
    for (let index = 0; index < depth; index++) {
      assert.ok(Array.isArray(payload));
      assert.ok(Object.isFrozen(payload));
      payload = payload[0];
    }
    assert.deepEqual(payload, { a: 1, b: [true, null] });
    assert.equal(restored.receive({
      clientId: "client-1", seq: 2,
      operations: [{ type: "value/set", path: "data", value: null }],
    }).commit.serverSeq, 2);
  });

  it("replays rejected List and Text deletions without deleting twice", () => {
    let reject = false;
    const server = createServer(Board, {
      resolve: ({ batch }) => reject ? [] : batch.operations,
    });
    assert.equal(server.openClient(), "client-1");
    const batches: BoardBatch[] = [];
    const doc = createClient(Board, {
      clientId: "client-1",
      onBatch: (batch) => batches.push(batch),
    });
    doc.transact(() => {
      doc.state.items.push("keep");
      doc.state.body.insert(0, "A😀");
    });
    doc.receive(server.receive(batches[0]!).commit);
    reject = true;
    doc.transact(() => {
      doc.state.items.delete(0);
      doc.state.body.delete(0, 2);
    });
    const first = server.receive(batches[1]!);
    const restored = createServer(Board, { checkpoint: server.checkpoint() });
    const retry = restored.receive(batches[1]!);
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.commit, first.commit);
    assert.deepEqual(retry.commit.operations, []);
    doc.receive(retry.commit);
    assert.deepEqual(doc.state.items.toArray(), ["keep"]);
    assert.equal(doc.state.body.toString(), "A😀");
    assert.equal(restored.snapshot().serverSeq, 2);
  });

  it("rejects new batches at sequence exhaustion while retaining safe retries", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const previous = makeBatch("client-1", max - 1, 0);
    let calls = 0;
    const server = createServer(Board, {
      checkpoint: {
        snapshot: { ...createServer(Board).snapshot(), serverSeq: max - 1 },
        history: [],
        lastClientNumber: 4, clients: [{
          batch: previous,
          commit: { serverSeq: max - 1, source: { clientId: "client-1", seq: max - 1 }, operations: [] },
        }].map((replay) => ({ clientId: replay.batch.clientId, replay })),
      },
      resolve: ({ batch }) => {
        calls++;
        return batch.operations;
      },
    });
    const last = makeBatch("client-1", max, 1);
    const receipt = server.receive(last);
    assert.equal(receipt.commit.serverSeq, max);
    const checkpoint = server.checkpoint();
    const restored = createServer(Board, { checkpoint });
    for (const document of [server, restored]) {
      assert.deepEqual(document.commitsSince(max - 1), [receipt.commit]);
      assert.deepEqual(document.commitsSince(max), []);
      const newcomer = document.openClient();
      const exhausted = document.checkpoint();
      assert.throws(() => document.receive(makeBatch(newcomer, 1, 2)), /Server sequence exhausted/);
      assert.deepEqual(document.checkpoint(), exhausted);
      const retry = document.receive(last);
      assert.equal(retry.replayed, true);
      assert.deepEqual(retry.commit, receipt.commit);
    }
    assert.equal(calls, 1);
  });
});
