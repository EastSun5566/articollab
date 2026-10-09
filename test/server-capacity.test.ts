import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createClient, createServer, decodeClientBatch, decodeServerCheckpoint,
  defineDocument, list, ServerDocument, text, value, WireDecodeError,
  type ClientBatch, type CreateServerOptions, type DocumentOperation,
} from "../src/index.ts";
const Board = defineDocument({ count: value(0), items: list<string>(), body: text() });
type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;
function batch(clientId: string, seq = 1, count = seq): Batch {
  return { clientId, seq, operations: [{ type: "value/set", path: "count", value: count }] };
}

describe("server client capacity", () => {
  it("defaults to unlimited and validates capacity in the factory and constructor", () => {
    for (const create of [
      (options: CreateServerOptions<Shape>) => createServer(Board, options),
      (options: CreateServerOptions<Shape>) => new ServerDocument(Board, options),
    ]) {
      for (const options of [{}, Object.defineProperty({}, "maxClients", { value: undefined })]) {
        const server = create(options);
        for (let index = 0; index < 4; index++) server.receive(batch(server.openClient()));
        assert.equal(server.checkpoint().clients.length, 4);
      }
      for (const maxClients of [0, 1, Number.MAX_SAFE_INTEGER]) {
        const server = create({ maxClients });
        if (maxClients === 0) {
          const before = server.checkpoint();
          assert.throws(() => server.openClient());
          assert.deepEqual(server.checkpoint(), before);
        } else assert.equal(server.receive(batch(server.openClient())).commit.serverSeq, 1);
      }
      for (const input of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "2", true, 1n]) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid numeric option verifies runtime validation.
        assert.throws(() => create({ maxClients: input as number }));
      }
    }
  });

  it("blocks unregistered writers before resolver or operation copying", () => {
    let calls = 0;
    const server = createServer(Board, { maxClients: 1, resolve: ({ batch: incoming }) => { calls++; return incoming.operations; } });
    const id = server.openClient();
    server.receive(batch(id));
    const before = server.checkpoint();
    assert.throws(() => server.openClient());
    for (const method of ["receive", "reject"] as const) {
      let reads = 0;
      const copyingError = new Error("must not copy");
      const input = Object.defineProperty(batch("client-2"), "operations", { get() { reads++; throw copyingError; } });
      assert.throws(() => server[method](input), (error) => error instanceof Error && error !== copyingError);
      assert.equal(reads, 0);
      assert.deepEqual(server.checkpoint(), before);
    }
    assert.equal(calls, 1);
    assert.equal(server.receive(batch(id, 2)).commit.serverSeq, 2);
  });

  it("keeps known-client submissions and cross-entrypoint retries working at capacity", () => {
    let calls = 0;
    const server = createServer(Board, { maxClients: 1, resolve: ({ batch: incoming }) => { calls++; return incoming.operations; } });
    const id = server.openClient();
    const first = server.receive(batch(id));
    for (const method of ["receive", "reject"] as const) assert.deepEqual(server[method](batch(id)), { commit: first.commit, replayed: true });
    const rejected = server.reject(batch(id, 2));
    const before = server.checkpoint();
    for (const method of ["receive", "reject"] as const) {
      assert.strictEqual(server[method](batch(id, 2)).commit, rejected.commit);
      for (const invalid of [batch(id), batch(id, 4), batch(id, 2, 99)]) {
        assert.throws(() => server[method](invalid));
        assert.deepEqual(server.checkpoint(), before);
      }
    }
    assert.equal(calls, 1);
    assert.equal(server.receive(batch(id, 3)).commit.serverSeq, 3);
    assert.equal(calls, 2);
    assert.equal(server.checkpoint().clients.length, 1);
  });

  it("counts unprocessed, accepted, rejected and transformed sessions until explicit close", () => {
    const server = createServer(Board, { maxClients: 4, resolve: ({ batch: incoming }) => {
      if (incoming.clientId === "client-2") return [];
      if (incoming.clientId === "client-4") return [{ type: "value/set", path: "count", value: 99 }];
      return incoming.operations;
    } });
    const ids = Array.from({ length: 4 }, () => server.openClient());
    assert.equal(server.checkpoint().clients.length, 4);
    assert.ok(server.checkpoint().clients.every((entry) => entry.replay === null));
    server.receive(batch(ids[0]!));
    assert.deepEqual(server.receive(batch(ids[1]!)).commit.operations, []);
    assert.deepEqual(server.reject(batch(ids[2]!)).commit.operations, []);
    server.receive(batch(ids[3]!));
    assert.equal(server.snapshot().data.count, 99);
    assert.throws(() => server.openClient());
    server.closeClient(ids[1]!);
    assert.equal(server.openClient(), "client-5");
    assert.equal(server.checkpoint().clients.length, 4);
    assert.equal(server.receive(batch(ids[0]!, 2)).commit.serverSeq, 5);
  });

  it("keeps the open session and sequence unchanged on policy, apply or reentrancy failure", () => {
    let mode = "throw";
    const server: ServerDocument<Shape> = createServer(Board, { maxClients: 1, resolve: ({ batch: incoming }) => {
      if (mode === "throw") throw new Error("policy failed");
      if (mode === "invalid") return [{ type: "list/delete", path: "items", id: { bunchId: "missing", counter: 0 } }];
      if (mode === "receive-reentrant") server.receive(incoming);
      if (mode === "reject-reentrant") server.reject(incoming);
      return incoming.operations;
    } });
    const id = server.openClient(), before = server.checkpoint();
    for (mode of ["throw", "invalid", "receive-reentrant", "reject-reentrant"]) {
      assert.throws(() => server.receive(batch(id)));
      assert.deepEqual(server.checkpoint(), before);
    }
    mode = "accept";
    assert.equal(server.receive(batch(id)).commit.serverSeq, 1);
  });

  it("does not release sessions merely because history is disabled or evicted", () => {
    for (const historyLimit of [0, 1]) {
      const server = createServer(Board, { maxClients: 2, historyLimit });
      const a = server.openClient(), b = server.openClient();
      const first = server.receive(batch(a));
      server.receive(batch(b));
      const before = server.checkpoint();
      assert.equal(before.history.length, historyLimit);
      assert.throws(() => server.openClient());
      assert.strictEqual(server.reject(batch(a)).commit, first.commit);
      assert.deepEqual(server.checkpoint(), before);
      server.closeClient(a);
      assert.equal(server.openClient(), "client-3");
    }
  });

  it("validates complete restore data then applies capacity without trimming open sessions", () => {
    const server = createServer(Board);
    const a = server.openClient(), b = server.openClient();
    server.receive(batch(a));
    const checkpoint = decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(server.checkpoint())));
    const saved = JSON.stringify(checkpoint);
    for (const maxClients of [0, 1]) {
      assert.throws(() => createServer(Board, { checkpoint, maxClients }));
      assert.equal(JSON.stringify(checkpoint), saved);
    }
    for (const maxClients of [2, 3, undefined]) {
      const restored = createServer(Board, { checkpoint, ...(maxClients === undefined ? {} : { maxClients }) });
      assert.deepEqual(restored.checkpoint(), checkpoint);
      assert.equal(restored.receive(batch(a)).replayed, true);
      assert.equal(restored.reject(batch(b)).commit.serverSeq, 2);
      if (maxClients === 2) assert.throws(() => restored.openClient());
      else assert.equal(restored.receive(batch(restored.openClient())).commit.serverSeq, 3);
    }
    const corrupt = { ...checkpoint, snapshot: { ...checkpoint.snapshot, serverSeq: 0 } };
    assert.throws(() => createServer(Board, { checkpoint: corrupt, maxClients: 0 }), WireDecodeError);
    assert.deepEqual(Object.keys(checkpoint).sort(), ["clients", "history", "lastClientNumber", "snapshot"]);
  });

  it("preserves unregistered mixed work until the intended session is explicitly opened", () => {
    let server = createServer(Board, { maxClients: 1 });
    const id = server.openClient();
    const established = server.receive(batch(id));
    const peer = createClient(Board, { clientId: id, snapshot: server.snapshot(), onBatch() {} });
    const doc = createClient(Board, { clientId: "client-2", snapshot: server.snapshot(), onBatch() {} });
    doc.transact(() => { doc.state.count.set(2); doc.state.items.push("pending"); doc.state.body.insert(0, "Hi😀"); });
    const pending = doc.checkpoint(), before = server.checkpoint();
    const original = pending.pendingBatches[0]!;
    assert.throws(() => server.receive(original));
    assert.throws(() => server.reject(original));
    assert.deepEqual(server.checkpoint(), before);
    assert.deepEqual(doc.checkpoint(), pending);
    server = createServer(Board, { maxClients: 2, checkpoint: decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(before))) });
    assert.equal(server.receive(batch(id)).replayed, true);
    assert.equal(established.commit.serverSeq, 1);
    assert.equal(server.openClient(), "client-2");
    const receipt = server.receive(decodeClientBatch(Board, JSON.parse(JSON.stringify(original))));
    doc.receive(receipt.commit); peer.receive(receipt.commit);
    assert.deepEqual(doc.checkpoint().pendingBatches, []);
    assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(peer.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(doc.state.items.toArray(), peer.state.items.toArray());
    assert.equal(doc.state.body.toString(), peer.state.body.toString());
  });
});
