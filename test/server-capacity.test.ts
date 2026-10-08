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
    const factories = [
      (options: CreateServerOptions<Shape>) => createServer(Board, options),
      (options: CreateServerOptions<Shape>) => new ServerDocument(Board, options),
    ];
    for (const create of factories) {
      // Plain JS can explicitly supply undefined; strict optional TS callers omit it.
      for (const options of [{}, Object.defineProperty({}, "maxClients", { value: undefined })]) {
        const server = create(options);
        for (let index = 0; index < 4; index++) server.receive(batch(`client-${index}`));
        assert.equal(server.checkpoint().replays.length, 4);
      }
      for (const maxClients of [0, 1, Number.MAX_SAFE_INTEGER]) {
        const server = create({ maxClients });
        if (maxClients === 0) {
          const before = server.checkpoint();
          assert.throws(() => server.receive(batch("new")), Error);
          assert.throws(() => server.reject(batch("new")), Error);
          assert.deepEqual(server.checkpoint(), before);
        } else {
          assert.equal(server.receive(batch("new")).commit.serverSeq, 1);
        }
      }
      for (const input of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "2", true, 1n]) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately bypass the numeric option type to exercise constructor validation.
        assert.throws(() => create({ maxClients: input as number }), Error);
      }
    }
  });

  it("blocks both new-client entrypoints before resolver or operation copying", () => {
    let calls = 0;
    const server = createServer(Board, { maxClients: 1, resolve: ({ batch: incoming }) => {
      calls++;
      return incoming.operations;
    } });
    server.receive(batch("known"));
    const before = server.checkpoint();
    for (const method of ["receive", "reject"] as const) {
      assert.throws(() => server[method](batch("new")), Error);
      // If copying runs first, this diagnostic getter throws its distinct error.
      let reads = 0;
      const copyingError = new Error("must not copy");
      const input = Object.defineProperty(batch("new"), "operations", {
        get() { reads++; throw copyingError; },
      });
      assert.throws(() => server[method](input), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.notStrictEqual(error, copyingError);
        return true;
      });
      assert.equal(reads, 0);
      assert.deepEqual(server.checkpoint(), before);
    }
    assert.equal(calls, 1);
    assert.equal(server.receive(batch("known", 2)).commit.serverSeq, 2);
  });

  it("keeps known-client submissions and cross-entrypoint retries working at capacity", () => {
    let calls = 0;
    const server = createServer(Board, { maxClients: 1, resolve: ({ batch: incoming }) => {
      calls++;
      return incoming.operations;
    } });
    const first = server.receive(batch("known"));
    for (const method of ["receive", "reject"] as const) {
      const retry = server[method](batch("known"));
      assert.equal(retry.replayed, true);
      assert.strictEqual(retry.commit, first.commit);
    }
    const rejected = server.reject(batch("known", 2));
    const before = server.checkpoint();
    for (const method of ["receive", "reject"] as const) {
      const retry = server[method](batch("known", 2));
      assert.equal(retry.replayed, true);
      assert.strictEqual(retry.commit, rejected.commit);
      for (const invalid of [batch("known"), batch("known", 4), batch("known", 2, 99)]) {
        assert.throws(() => server[method](invalid), Error);
        assert.deepEqual(server.checkpoint(), before);
      }
    }
    assert.equal(calls, 1);
    assert.equal(server.receive(batch("known", 3)).commit.serverSeq, 3);
    assert.equal(calls, 2);
    assert.equal(server.checkpoint().replays.length, 1);
  });

  it("counts accepted, policy-rejected, explicitly rejected and transformed clients once", () => {
    const server = createServer(Board, { maxClients: 4, resolve: ({ batch: incoming }) => {
      if (incoming.clientId === "policy") return [];
      if (incoming.clientId === "transform") return [{ type: "value/set", path: "count", value: 99 }];
      return incoming.operations;
    } });
    server.receive(batch("accepted"));
    assert.deepEqual(server.receive(batch("policy")).commit.operations, []);
    assert.deepEqual(server.reject(batch("explicit")).commit.operations, []);
    server.receive(batch("transform"));
    assert.equal(server.snapshot().data.count, 99);
    assert.equal(server.checkpoint().replays.length, 4);
    const before = server.checkpoint();
    assert.throws(() => server.receive(batch("fifth")), Error);
    assert.throws(() => server.reject(batch("fifth")), Error);
    assert.deepEqual(server.checkpoint(), before);
    assert.equal(server.receive(batch("accepted", 2)).commit.serverSeq, 5);
    assert.equal(server.checkpoint().replays.length, 4);
  });

  it("does not consume a slot or sequence on policy, apply or reentrancy failure", () => {
    const modes = ["throw", "invalid", "receive-reentrant", "reject-reentrant"] as const;
    let mode: typeof modes[number] | "accept" = "throw";
    const failure = new Error("policy failed");
    const server = createServer(Board, { maxClients: 1, resolve: ({ batch: incoming }) => {
      if (mode === "throw") throw failure;
      if (mode === "invalid") return [{ type: "list/delete", path: "items", id: { bunchId: "missing", counter: 0 } }];
      if (mode === "receive-reentrant") server.receive(batch("nested"));
      if (mode === "reject-reentrant") server.reject(batch("nested"));
      return incoming.operations;
    } });
    const before = server.checkpoint();
    for (const nextMode of modes) {
      mode = nextMode;
      assert.throws(() => server.receive(batch("new")), Error);
      assert.deepEqual(server.checkpoint(), before);
    }
    mode = "accept";
    const commit = server.receive(batch("new")).commit;
    assert.equal(commit.serverSeq, 1);
    assert.equal(commit.source.seq, 1);
    assert.equal(server.checkpoint().replays.length, 1);
  });

  it("does not release client slots when history is disabled or evicted", () => {
    for (const historyLimit of [0, 1]) {
      const server = createServer(Board, { maxClients: 2, historyLimit });
      const first = server.receive(batch("a"));
      server.receive(batch("b"));
      assert.equal(server.checkpoint().history.length, historyLimit);
      const before = server.checkpoint();
      assert.throws(() => server.receive(batch("c")), Error);
      assert.deepEqual(server.checkpoint(), before);
      const retry = server.reject(batch("a"));
      assert.equal(retry.replayed, true);
      assert.strictEqual(retry.commit, first.commit);
      assert.deepEqual(server.checkpoint(), before);
      assert.equal(server.checkpoint().replays.length, 2);
    }
  });

  it("validates the complete checkpoint then enforces capacity without trimming clients", () => {
    const server = createServer(Board);
    server.receive(batch("a"));
    server.reject(batch("b"));
    const checkpoint = decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(server.checkpoint())));
    const saved = JSON.stringify(checkpoint);
    for (const maxClients of [0, 1]) {
      assert.throws(() => createServer(Board, { checkpoint, maxClients }), Error);
      assert.equal(JSON.stringify(checkpoint), saved);
    }
    for (const maxClients of [2, 3, undefined]) {
      const restored = createServer(Board, { checkpoint, ...(maxClients === undefined ? {} : { maxClients }) });
      assert.deepEqual(restored.checkpoint(), checkpoint);
      assert.equal(restored.receive(batch("a")).replayed, true);
      assert.equal(restored.receive(batch("b")).replayed, true);
      assert.equal(restored.receive(batch("a", 2)).commit.serverSeq, 3);
      if (maxClients === 2) assert.throws(() => restored.receive(batch("c")), Error);
      else assert.equal(restored.receive(batch("c")).commit.serverSeq, 4);
    }
    const corrupt = { ...checkpoint, snapshot: { ...checkpoint.snapshot, serverSeq: 0 } };
    assert.throws(() => createServer(Board, { checkpoint: corrupt, maxClients: 0 }), WireDecodeError);
    assert.deepEqual(Object.keys(checkpoint).sort(), ["history", "replays", "snapshot"]);
  });

  it("preserves unacknowledged mixed work until a higher-capacity server accepts it", () => {
    let server = createServer(Board, { maxClients: 1 });
    const established = server.receive(batch("established"));
    const peer = createClient(Board, { clientId: "established", snapshot: server.snapshot(), onBatch() {} });
    const doc = createClient(Board, { clientId: "new", snapshot: server.snapshot(), onBatch() {} });
    doc.transact(() => {
      doc.state.count.set(2);
      doc.state.items.push("pending");
      doc.state.body.insert(0, "Hi😀");
    });
    const pending = doc.checkpoint();
    const original = pending.pendingBatches[0]!;
    const serverBefore = server.checkpoint();
    assert.throws(() => server.receive(original), Error);
    assert.throws(() => server.reject(original), Error);
    assert.deepEqual(server.checkpoint(), serverBefore);
    assert.deepEqual(doc.checkpoint(), pending);
    assert.equal(doc.state.count.value, 2);
    assert.deepEqual(doc.state.items.toArray(), ["pending"]);
    assert.equal(doc.state.body.toString(), "Hi😀");
    server = createServer(Board, { maxClients: 2,
      checkpoint: decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(serverBefore))) });
    assert.equal(server.receive(batch("established")).replayed, true);
    assert.equal(established.commit.serverSeq, 1);
    const receipt = server.receive(decodeClientBatch(Board, JSON.parse(JSON.stringify(original))));
    assert.equal(receipt.commit.serverSeq, 2);
    doc.receive(receipt.commit);
    peer.receive(receipt.commit);
    assert.deepEqual(doc.checkpoint().pendingBatches, []);
    assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(peer.checkpoint().snapshot, server.snapshot());
    assert.equal(doc.state.count.value, peer.state.count.value);
    assert.deepEqual(doc.state.items.toArray(), peer.state.items.toArray());
    assert.equal(doc.state.body.toString(), peer.state.body.toString());
  });
});
