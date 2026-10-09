import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createClient, createServer, decodeServerCheckpoint, defineDocument, value,
  WireDecodeError, type ClientBatch, type ServerDocument,
} from "../src/index.ts";

const Counter = defineDocument({ count: value(0) });
function batch(clientId: string, seq = 1): ClientBatch {
  return { clientId, seq, operations: [{ type: "value/set", path: "count", value: seq }] };
}

it("opens sessions explicitly and closes without changing document or history", () => {
  const server = createServer(Counter, { maxClients: 1 });
  const initial = server.checkpoint();
  assert.deepEqual(initial, { snapshot: server.snapshot(), lastClientNumber: 0, clients: [], history: [] });
  const id = server.openClient();
  assert.equal(id, "client-1");
  assert.deepEqual(server.checkpoint().clients, [{ clientId: id, replay: null }]);
  const opened = server.checkpoint();
  assert.throws(() => server.openClient());
  assert.deepEqual(server.checkpoint(), opened);
  const receipt = server.receive({ ...batch(id), operations: [{ type: "value/set", path: "count", value: 1 }] });
  const processed = server.checkpoint();
  server.closeClient(id);
  server.closeClient(id);
  assert.deepEqual(server.checkpoint().clients, []);
  assert.deepEqual(server.snapshot(), processed.snapshot);
  assert.deepEqual(server.commitsSince(0), [receipt.commit]);
  assert.equal(server.openClient(), "client-2");
  assert.equal(opened.clients[0]?.replay, null);
  assert.equal(processed.clients[0]?.replay?.batch.clientId, id);
  assert.equal(initial.lastClientNumber, 0);
});

it("refuses unknown and closed writers across receive, reject and retries", () => {
  let calls = 0;
  const server = createServer(Counter, { resolve: ({ batch: incoming }) => { calls++; return incoming.operations; } });
  const id = server.openClient();
  const input = { ...batch(id), operations: [{ type: "value/set" as const, path: "count" as const, value: 1 }] };
  const result = server.receive(input);
  assert.strictEqual(server.reject(input).commit, result.commit);
  server.closeClient(id);
  const checkpoint = server.checkpoint();
  for (const clientId of [id, "client-2", "writer", "client-01"]) {
    const incoming = { ...input, clientId };
    assert.throws(() => server.receive(incoming));
    assert.throws(() => server.reject(incoming));
    assert.deepEqual(server.checkpoint(), checkpoint);
  }
  assert.equal(calls, 1);
  for (const invalid of ["", "client-0", "client-01", "client-1\n", "client-2", "client-9007199254740992"]) {
    assert.throws(() => server.closeClient(invalid), TypeError);
  }
});

it("restores unprocessed sessions, original retries, closed history and allocation progress", () => {
  const server = createServer(Counter);
  const a = server.openClient(), b = server.openClient();
  const input = { ...batch(a), operations: [{ type: "value/set" as const, path: "count" as const, value: 1 }] };
  const receipt = server.receive(input);
  server.closeClient(a);
  const saved = decodeServerCheckpoint(Counter, JSON.parse(JSON.stringify(server.checkpoint())));
  const restored = createServer(Counter, { checkpoint: saved });
  assert.deepEqual(restored.commitsSince(0), [receipt.commit]);
  assert.throws(() => restored.receive(input));
  assert.equal(restored.openClient(), "client-3");
  restored.reject({ ...input, clientId: b });
  assert.equal(restored.snapshot().serverSeq, 2);
  assert.equal(restored.snapshot().data.count, 1);
  const again = createServer(Counter, { checkpoint: restored.checkpoint(), historyLimit: 0 });
  assert.equal(again.receive({ ...input, clientId: b }).replayed, true);
  assert.equal(again.openClient(), "client-4");
});

it("guards lifecycle changes during policy and leaves failures atomic", () => {
  const error = new Error("policy failed");
  let fail = true;
  const server: ServerDocument<typeof Counter.definition> = createServer(Counter, { resolve: ({ batch: incoming }) => {
    const before = server.checkpoint();
    assert.throws(() => server.openClient());
    assert.throws(() => server.closeClient(incoming.clientId));
    assert.deepEqual(server.checkpoint(), before);
    if (fail) throw error;
    return incoming.operations;
  } });
  const id = server.openClient();
  const input = { ...batch(id), operations: [{ type: "value/set" as const, path: "count" as const, value: 1 }] };
  const before = server.checkpoint();
  assert.throws(() => server.receive(input), (thrown) => thrown === error);
  assert.deepEqual(server.checkpoint(), before);
  fail = false;
  assert.equal(server.receive(input).commit.serverSeq, 1);
});

it("checks allocation exhaustion and validates new checkpoints without old-format fallback", () => {
  const empty = createServer(Counter).checkpoint();
  const exhausted = createServer(Counter, { checkpoint: { ...empty, lastClientNumber: Number.MAX_SAFE_INTEGER } });
  assert.throws(() => exhausted.openClient());
  assert.deepEqual(exhausted.checkpoint().clients, []);
  assert.throws(() => createServer(Counter, { maxClients: 0 }).openClient());
  const invalid: unknown[] = [
    { snapshot: empty.snapshot, replays: [], history: [] },
    { ...empty, lastClientNumber: -1 },
    { ...empty, snapshot: { ...empty.snapshot, serverSeq: 1 } },
    { ...empty, clients: [{ clientId: "client-1", replay: null }] },
    { ...empty, lastClientNumber: 1, clients: [{ clientId: "client-01", replay: null }] },
    { ...empty, lastClientNumber: 1, clients: [{ clientId: "client-1\n", replay: null }] },
    { ...empty, lastClientNumber: 1, clients: [{ clientId: "client-1", replay: null }, { clientId: "client-1", replay: null }] },
    { ...empty, clients: new Array(1) },
  ];
  for (const input of invalid) assert.throws(() => decodeServerCheckpoint(Counter, input), WireDecodeError);
});

it("closing drops rejected retry payload but does not pretend to purge caller checkpoints", () => {
  const Data = defineDocument({ data: value("") });
  const server = createServer(Data, { historyLimit: 0 });
  const id = server.openClient();
  const doc = createClient(Data, { clientId: id, onBatch() {} });
  doc.state.data.value = "x".repeat(100_000);
  server.reject(doc.checkpoint().pendingBatches[0]!);
  const saved = server.checkpoint();
  assert.equal(saved.clients[0]?.replay?.batch.operations[0]?.value.length, 100_000);
  server.closeClient(id);
  assert.deepEqual(server.checkpoint().clients, []);
  assert.deepEqual(server.checkpoint().history, []);
  assert.equal(saved.clients.length, 1);
  assert.equal(doc.checkpoint().pendingBatches.length, 1);
});
