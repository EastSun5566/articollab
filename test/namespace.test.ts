import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertClientBatchNamespace, createClient, createServer, decodeClientBatch,
  decodeClientCheckpoint, decodeServerCheckpoint, defineDocument, list, text, value,
  type ClientBatch, type DocumentOperation,
} from "../src/index.ts";

const Board = defineDocument({ count: value(0), items: list<string>(), body: text() });
type Batch = ClientBatch<DocumentOperation<typeof Board.definition>>;

function setup(clientId: string) {
  const batches: Batch[] = [];
  const doc = createClient(Board, { clientId, onBatch: (batch) => batches.push(batch) });
  return { doc, batches };
}

function insertion(clientId: string, bunchId: string, kind: "list" | "text" = "list"): Batch {
  return { clientId, seq: 1, operations: [kind === "list"
    ? { type: "list/insert", path: "items", before: null, id: { bunchId, counter: 0 }, value: "item" }
    : { type: "text/insert", path: "body", before: null, id: { bunchId, counter: 0 }, value: "😀A" }] };
}

describe("client batch namespace guard", () => {
  it("accepts generated mixed batches, bunch extensions and restored allocation progress", () => {
    let server = createServer(Board);
    const clientId = server.openClient();
    const { doc, batches } = setup(clientId);
    doc.state.count.value = 1;
    doc.transact(() => { doc.state.items.push("first"); doc.state.body.insert(0, "😀A"); });
    doc.transact(() => { doc.state.items.push("second"); doc.state.body.insert(2, "🦊"); });
    for (const batch of batches) {
      assert.equal(assertClientBatchNamespace(batch, clientId), undefined);
      const decoded = decodeClientBatch(Board, JSON.parse(JSON.stringify(batch)));
      assertClientBatchNamespace(decoded, clientId);
      doc.receive(server.receive(decoded).commit);
    }
    for (const [path, counter] of [["items", 1], ["body", 2]] as const) {
      const first = batches[1]!.operations.find((operation) => operation.path === path);
      const extended = batches[2]!.operations.find((operation) => operation.path === path);
      assert.ok(first?.type === "list/insert" || first?.type === "text/insert");
      assert.ok(extended?.type === "list/insert" || extended?.type === "text/insert");
      assert.equal(first.id.bunchId, JSON.stringify([clientId, path, 1]));
      assert.equal(extended.id.bunchId, first.id.bunchId);
      assert.equal(extended.id.counter, counter);
    }

    const checkpoint = decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(doc.checkpoint())));
    server = createServer(Board, { checkpoint: decodeServerCheckpoint(Board,
      JSON.parse(JSON.stringify(server.checkpoint()))) });
    const restored = createClient(Board, { clientId, checkpoint,
      onBatch: (batch) => batches.push(batch) });
    restored.transact(() => {
      restored.state.items.push("restored");
      restored.state.body.insert(restored.state.body.length, "Hi😀");
    });
    assert.equal(batches[3]!.seq, 4);
    assertClientBatchNamespace(batches[3]!, clientId);
    restored.receive(server.receive(batches[3]!).commit);
    assert.deepEqual(restored.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(restored.checkpoint().pendingBatches, []);
    for (const path of ["items", "body"] as const) {
      assert.ok(restored.checkpoint().lastBunchSeqs[path] > checkpoint.lastBunchSeqs[path]);
    }
  });

  it("handles escaped writer IDs and collection paths without prefix matching", () => {
    const clientId = 'writer/"😀';
    const path = 'items/~"';
    const schema = defineDocument({ [path]: list<string>() });
    const doc = createClient(schema, { clientId, onBatch(batch) {
      assertClientBatchNamespace(batch, clientId);
    } });
    doc.state[path].push("valid");
    assertClientBatchNamespace({ clientId, seq: 1, operations: [{
      type: "list/insert", path, before: null,
      id: { bunchId: JSON.stringify([clientId, path, Number.MAX_SAFE_INTEGER]), counter: 10 }, value: "valid",
    }] }, clientId);
  });

  it("rejects foreign namespaces, invalid bunch sequences and non-canonical encodings", () => {
    for (const kind of ["list", "text"] as const) {
      const path = kind === "list" ? "items" : "body";
      const wrongPath = kind === "list" ? "body" : "items";
      const invalid = [
        JSON.stringify(["other", path, 1]), JSON.stringify(["writer-extra", path, 1]),
        JSON.stringify(["writer", wrongPath, 1]), JSON.stringify(["writer", `${path}-extra`, 1]),
        ...[0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1].map((seq) => JSON.stringify(["writer", path, seq])),
        JSON.stringify(["writer", path]), JSON.stringify(["writer", path, 1, "extra"]),
        JSON.stringify(["writer", path, 1], null, 2), ` ["writer","${path}",1]`,
        `["writer","${path}",1e0]`, `["writer","${path}",1.0]`,
        `["\\u0077riter","${path}",1]`, "not-json", "null", "{}", "1",
      ];
      for (const bunchId of invalid) {
        const batch = decodeClientBatch(Board, insertion("writer", bunchId, kind));
        assert.throws(() => assertClientBatchNamespace(batch, "writer"), TypeError, bunchId);
      }
    }
  });

  it("checks writer binding even for Value-only batches and leaves input ownership unchanged", () => {
    const batch: ClientBatch = { clientId: "writer", seq: 1, operations: [
      { type: "value/set", path: "count", value: 1 },
      { type: "list/insert", path: "items", before: { bunchId: "peer", counter: 0 },
        id: { bunchId: JSON.stringify(["writer", "items", 1]), counter: 0 }, value: { label: "original" } },
    ] };
    const before = structuredClone(batch);
    const operation = batch.operations[1]!;
    assert.ok(operation.type === "list/insert");
    const references = [batch, batch.operations, operation, operation.id, operation.before, operation.value];
    assert.equal(assertClientBatchNamespace(batch, "writer"), undefined);
    assert.deepEqual(batch, before);
    const after = [batch, batch.operations, batch.operations[1], operation.id, operation.before, operation.value];
    for (const [index, reference] of references.entries()) {
      assert.equal(after[index], reference);
      assert.equal(Object.isFrozen(reference), false);
    }

    const valueOnly: Batch = { clientId: "writer", seq: 1,
      operations: [{ type: "value/set", path: "count", value: 1 }] };
    assertClientBatchNamespace(valueOnly, "writer");
    assert.throws(() => assertClientBatchNamespace(valueOnly, "other"), TypeError);
    assert.throws(() => assertClientBatchNamespace(valueOnly, ""), TypeError);
  });

  it("permits cross-writer insertion anchors and deletion targets", () => {
    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const peer = setup("client-2");
    const writer = setup("client-1");
    peer.doc.transact(() => { peer.doc.state.items.push("peer"); peer.doc.state.body.insert(0, "😀"); });
    const first = server.receive(peer.batches[0]!).commit;
    peer.doc.receive(first);
    writer.doc.receive(first);
    writer.doc.transact(() => {
      writer.doc.state.items.insert(1, "client-1");
      writer.doc.state.body.insert(1, "A");
      writer.doc.state.items.delete(0);
      writer.doc.state.body.delete(0);
    });
    const batch = writer.batches[0]!;
    for (const operation of batch.operations) {
      const id = operation.type === "list/insert" || operation.type === "text/insert" ? operation.before
        : operation.type === "list/delete" ? operation.id
          : operation.type === "text/delete" ? operation.ranges[0]!.start : null;
      assert.ok(id?.bunchId.startsWith('["client-2",'));
    }
    assertClientBatchNamespace(batch, "client-1");
    const second = server.receive(batch).commit;
    peer.doc.receive(second);
    writer.doc.receive(second);
    assert.deepEqual(server.snapshot().data.items.values, ["client-1"]);
    assert.equal(server.snapshot().data.body.value, "A");
  });

  it("prevents preempting another writer's future IDs without advancing the server", () => {
    let calls = 0;
    const server = createServer(Board, { resolve: ({ batch }) => { calls++; return batch.operations; } });
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const victim = setup("client-1");
    victim.doc.transact(() => { victim.doc.state.items.push("safe"); victim.doc.state.body.insert(0, "😀"); });
    const legitimate = victim.batches[0]!;
    const attack = decodeClientBatch(Board, { ...legitimate, clientId: "client-2" });
    const checkpoint = server.checkpoint();
    const history = server.commitsSince(0);
    assert.throws(() => server.receive(attack), TypeError);
    assert.deepEqual(server.checkpoint(), checkpoint);
    assert.deepEqual(server.commitsSince(0), history);
    assert.equal(calls, 0);
    assertClientBatchNamespace(legitimate, "client-1");
    const commit = server.receive(legitimate).commit;
    assert.equal(commit.serverSeq, 1);
    victim.doc.receive(commit);
    assert.deepEqual(victim.doc.checkpoint().pendingBatches, []);
    assert.equal(calls, 1);

    const unguarded = createServer(Board, { allowCustomClientNamespaces: true });
    assert.equal(unguarded.openClient(), "client-1");
    assert.equal(unguarded.openClient(), "client-2");
    unguarded.receive(attack);
    assert.throws(() => unguarded.receive(legitimate), Error);
  });

  it("preserves original-result retries while leaving runtime payload checks in place", () => {
    for (const entrypoint of ["receive", "reject"] as const) {
      let calls = 0;
      const server = createServer(Board, { resolve: ({ batch }) => { calls++; return batch.operations; } });
      assert.equal(server.openClient(), "client-1");
      const batch = insertion("client-1", JSON.stringify(["client-1", "items", 1]));
      assertClientBatchNamespace(batch, "client-1");
      const first = server[entrypoint](batch);
      const checkpoint = server.checkpoint();
      for (const retryEntrypoint of ["receive", "reject"] as const) {
        const retryBatch = decodeClientBatch(Board, JSON.parse(JSON.stringify(batch)));
        assertClientBatchNamespace(retryBatch, "client-1");
        const retry = server[retryEntrypoint](retryBatch);
        assert.equal(retry.replayed, true);
        assert.equal(retry.commit, first.commit);
        assert.deepEqual(server.checkpoint(), checkpoint);
      }
      const changed = insertion("client-1", JSON.stringify(["client-1", "items", 2]));
      assertClientBatchNamespace(changed, "client-1");
      assert.throws(() => server.receive(changed), Error);
      assert.deepEqual(server.checkpoint(), checkpoint);
      assert.equal(calls, entrypoint === "receive" ? 1 : 0);
    }
  });

  it("allows trusted rejection of an invalid namespace and retains it across restore", () => {
    const batch = decodeClientBatch(Board, insertion("client-1", JSON.stringify(["other", "items", 1])));
    assert.throws(() => assertClientBatchNamespace(batch, "client-1"), TypeError);
    const server = createServer(Board, { resolve() { assert.fail("reject must skip policy"); } });
    assert.equal(server.openClient(), "client-1");
    const before = server.snapshot().data;
    const authenticatedWriterId = "client-1";
    assert.equal(batch.clientId, authenticatedWriterId);
    const receipt = server.reject(batch);
    assert.deepEqual(receipt.commit.operations, []);
    assert.equal(receipt.commit.serverSeq, 1);
    assert.deepEqual(server.snapshot().data, before);
    const checkpoint = decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(server.checkpoint())));
    const restored = createServer(Board, { checkpoint });
    assert.equal(restored.receive(batch).replayed, true);
    assert.deepEqual(restored.commitsSince(0), [receipt.commit]);
  });

  it("allows explicitly opted-out incoming namespaces and unrestricted resolver-generated IDs", () => {
    const custom = insertion("client-1", "application-owned-list");
    assert.throws(() => assertClientBatchNamespace(custom, "client-1"), TypeError);
    const unguarded = createServer(Board, { allowCustomClientNamespaces: true });
    assert.equal(unguarded.openClient(), "client-1");
    unguarded.receive(custom);
    assert.deepEqual(unguarded.snapshot().data.items.values, ["item"]);

    const server = createServer(Board, { resolve: ({ batch }) => batch.operations.map((operation) => {
      if (operation.type !== "list/insert" && operation.type !== "text/insert") return operation;
      return { ...operation, id: { bunchId: `server-owned-${operation.path}`, counter: 0 } };
    }) });
    assert.equal(server.openClient(), "client-1");
    const { doc, batches } = setup("client-1");
    doc.transact(() => { doc.state.items.push("first"); doc.state.body.insert(0, "😀"); });
    assertClientBatchNamespace(batches[0]!, "client-1");
    const receipt = server.receive(batches[0]!);
    doc.receive(receipt.commit);
    assert.deepEqual(doc.checkpoint().pendingBatches, []);
    assert.deepEqual(server.snapshot().data.items.values, ["first"]);
    assert.equal(doc.state.body.toString(), "😀");
  });

  it("checks new mixed batches before policy without advancing state, history or sequences", () => {
    let calls = 0;
    const server = createServer(Board, { resolve({ batch }) { calls++; return batch.operations; } });
    const clientId = server.openClient();
    const before = server.checkpoint();
    for (const kind of ["list", "text"] as const) {
      const path = kind === "list" ? "items" : "body";
      const invalid = [
        JSON.stringify(["client-2", path, 1]), JSON.stringify([clientId, "count", 1]),
        ...[0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]
          .map((seq) => JSON.stringify([clientId, path, seq])),
        JSON.stringify([clientId, path, 1], null, 2),
        `["${clientId}","${path}",1e0]`, "application-owned",
      ];
      for (const bunchId of invalid) {
        const batch = decodeClientBatch(Board, insertion(clientId, bunchId, kind));
        const mixed: Batch = { ...batch, operations: [
          { type: "value/set", path: "count", value: 99 }, ...batch.operations,
        ] };
        assert.throws(() => server.receive(mixed), TypeError);
        assert.deepEqual(server.checkpoint(), before);
        assert.deepEqual(server.commitsSince(0), []);
        assert.equal(calls, 0);
      }
    }
    const { doc, batches } = setup(clientId);
    doc.transact(() => { doc.state.items.push("valid"); doc.state.body.insert(0, "😀"); });
    const receipt = server.receive(batches[0]!);
    assert.equal(receipt.commit.serverSeq, 1);
    assert.equal(calls, 1);
  });

  it("defaults to namespace checks, validates the option and preserves state validation when opted out", () => {
    for (const options of [{}, { allowCustomClientNamespaces: false }] as const) {
      const server = createServer(Board, options);
      const clientId = server.openClient();
      const before = server.checkpoint();
      assert.throws(() => server.receive(insertion(clientId, "custom")), TypeError);
      assert.deepEqual(server.checkpoint(), before);
    }
    for (const invalid of [null, 0, 1, "false", {}, []]) {
      // @ts-expect-error Deliberately test JavaScript callers with a non-boolean option.
      assert.throws(() => createServer(Board, { allowCustomClientNamespaces: invalid }), TypeError);
    }
    const server = createServer(Board, { allowCustomClientNamespaces: true });
    const clientId = server.openClient();
    const custom = insertion(clientId, "custom");
    const receipt = server.receive(custom);
    assert.equal(receipt.commit.serverSeq, 1);
    const before = server.checkpoint();
    assert.throws(() => server.receive({ ...custom, seq: 2 }), Error);
    assert.deepEqual(server.checkpoint(), before);
  });

  it("retains custom-ID results across default restore without allowing new custom submissions", () => {
    const server = createServer(Board, { allowCustomClientNamespaces: true });
    const clientId = server.openClient();
    const batch = insertion(clientId, "custom");
    const original = server.receive(batch);
    const checkpoint = decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(server.checkpoint())));
    const restored = createServer(Board, { checkpoint });
    for (const entrypoint of ["receive", "reject"] as const) {
      const retry = restored[entrypoint](decodeClientBatch(Board, JSON.parse(JSON.stringify(batch))));
      assert.equal(retry.replayed, true);
      assert.deepEqual(retry.commit, original.commit);
      assert.deepEqual(restored.checkpoint(), checkpoint);
    }
    const next: Batch = { ...insertion(clientId, "custom-next"), seq: 2 };
    assert.throws(() => restored.receive(next), TypeError);
    assert.deepEqual(restored.checkpoint(), checkpoint);
    const optedOut = createServer(Board, { checkpoint, allowCustomClientNamespaces: true });
    assert.equal(optedOut.receive(next).commit.serverSeq, 2);
  });

  it("keeps namespace-invalid rejection retries across both entrypoints and restore", () => {
    const server = createServer(Board, { resolve() { assert.fail("namespace-invalid batches must not reach policy"); } });
    const clientId = server.openClient();
    const batch = insertion(clientId, "custom");
    assert.throws(() => server.receive(batch), TypeError);
    const result = server.reject(batch);
    const checkpoint = decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(server.checkpoint())));
    for (const document of [server, createServer(Board, { checkpoint })]) {
      for (const entrypoint of ["receive", "reject"] as const) {
        const retry = document[entrypoint](decodeClientBatch(Board, JSON.parse(JSON.stringify(batch))));
        assert.equal(retry.replayed, true);
        assert.deepEqual(retry.commit, result.commit);
        assert.deepEqual(document.checkpoint(), checkpoint);
        assert.throws(() => document[entrypoint](insertion(clientId, "changed")), Error);
        assert.throws(() => document[entrypoint]({ ...batch, seq: 0 }), Error);
        assert.throws(() => document[entrypoint]({ ...batch, seq: 3 }), Error);
        assert.deepEqual(document.checkpoint(), checkpoint);
      }
      const next = document.reject({ ...batch, seq: 2 });
      assert.equal(next.commit.serverSeq, 2);
      assert.deepEqual(next.commit.operations, []);
      const after = document.checkpoint();
      assert.throws(() => document.receive(batch), Error);
      assert.deepEqual(document.checkpoint(), after);
    }
  });
});
