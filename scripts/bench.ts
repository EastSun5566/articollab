import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import type { Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { arch, cpus, platform, release } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import type {
  ClientBatch, ClientDocument, DocumentOperation, DocumentSnapshot, ServerCommit,
  ListSchema, TextSchema, ValueSchema,
} from "../src/index.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const filename = fileURLToPath(import.meta.url);
const execute = promisify(execFile);
const kinds = ["list", "text"] as const;
const scenarios = ["local-insert", "local-delete", "sync-insert", "pending-replay",
  "materialize", "snapshot", "unused-policy-snapshot", "unchanged-receive", "retained-heap"] as const;
const objectScenarios = ["object-json-ack", "object-own-replace-ack", "object-json-replace-ack",
  "object-remote-replace", "object-local-set", "object-json-set-ack", "object-remote-set",
  "object-remote-set-observed", "object-remote-replace-observed"] as const;
const pendingListScenarios = ["object-remote-set-pending-same", "object-remote-set-pending-disjoint",
  "object-remote-replace-pending-same", "object-remote-replace-pending-disjoint", "object-json-mixed-ack"] as const;
const pendingTextScenarios = ["remote-replace-pending-same", "remote-replace-pending-disjoint", "value-json-mixed-ack"] as const;
type ReconciliationScenario = typeof pendingListScenarios[number] | typeof pendingTextScenarios[number];
const extendedScenarios = ["local-insert", "local-delete", "bulk-delete", "remote-replace",
  "remote-noop-delete", "pending-replay", "client-decode-restore", "server-decode-restore", "retained-heap"] as const;
type ExtendedScenario = typeof extendedScenarios[number];
type Kind = typeof kinds[number];
type Scenario = typeof scenarios[number] | typeof objectScenarios[number] | ReconciliationScenario;
type Shape = { count: ValueSchema<number>; items: ListSchema<string>; body: TextSchema };
type Doc = ClientDocument<Shape>;
type Batch = ClientBatch<DocumentOperation<Shape>>;
type Api = typeof import("../src/index.ts");

interface Result {
  kind: Kind;
  size: number;
  scenario: Scenario;
  unit: "ms/op" | "bytes";
  operationsPerSample: number;
  samples: number[];
  median: number;
  min: number;
  max: number;
  snapshotBytes: number;
  checkpointBytes: number;
}

interface FixtureStats {
  seed: number;
  visibleIds: number;
  deletedIds: number;
  savedRanges: number;
  bunches: number;
  snapshotSha256: string;
}

interface ExtendedResult extends Omit<Result, "kind" | "scenario"> {
  kind: "text" | "history";
  scenario: ExtendedScenario | "history-receive";
  fixture?: FixtureStats;
}

function extendedSettings(smoke: boolean) {
  return { ...settings(smoke), sizes: smoke ? [32] : [10_000, 50_000, 100_000],
    historyLimits: smoke ? [0, 2, 4, 8] : [0, 1_000, 10_000, 100_000], seed: 42 };
}

function settings(smoke: boolean) {
  return { sizes: smoke ? [32] : [1_000, 10_000, 50_000], samples: smoke ? 2 : 5,
    iterations: smoke ? 2 : 10, pending: 20, warmups: 1 };
}

function fixture(kind: Kind, size: number): DocumentSnapshot<Shape> {
  const range = { bunchId: "seed", startCounter: 0, count: size, isDeleted: false };
  return { serverSeq: 0, data: {
    count: 0,
    items: { idList: kind === "list" ? [range] : [],
      values: kind === "list" ? Array<string>(size).fill("x") : [] },
    body: { idList: kind === "text" ? [range] : [], value: kind === "text" ? "x".repeat(size) : "" },
  } };
}

function board(api: Api) {
  return api.defineDocument({ count: api.value(0), items: api.list<string>(), body: api.text() });
}

function insert(doc: Doc, kind: Kind, index: number): void {
  if (kind === "list") doc.state.items.insert(index, "y");
  else doc.state.body.insert(index, "😀");
}

function visible(doc: Doc) {
  return { count: doc.state.count.value, items: doc.state.items.toArray(), body: doc.state.body.toString() };
}

function expected(kind: Kind, size: number, count = 0, inserted = 0, deleted = 0) {
  const midpoint = Math.floor(size / 2);
  if (kind === "list") {
    const items = Array<string>(size).fill("x");
    items.splice(midpoint, deleted, ...Array<string>(inserted).fill("y"));
    return { count, items, body: "" };
  }
  return { count, items: [], body: "x".repeat(midpoint) + "😀".repeat(inserted) +
    "x".repeat(size - midpoint - deleted) };
}

function collect(): void {
  assert.ok(globalThis.gc, "Run the benchmark with node --expose-gc");
  globalThis.gc();
}

function timeTrial(api: Api, kind: Kind, size: number, scenario: typeof scenarios[number], iterations: number): number {
  const schema = board(api);
  const snapshot = fixture(kind, size);
  const server = api.createServer(schema, {
    historyLimit: 0, checkpoint: { snapshot, lastClientNumber: 0, clients: [], history: [] },
    ...(scenario === "unused-policy-snapshot" ? { resolve: ({ batch }: { batch: Batch }) => batch.operations } : {}),
  });
  const batches: Batch[] = [];
  const recipients: Doc[] = [];
  const writerId = server.openClient(), peerId = server.openClient(), remoteId = server.openClient();
  const doc = api.createClient(schema, { clientId: writerId, snapshot, onBatch(batch) {
    batches.push(batch);
    if (scenario === "sync-insert") {
      const receipt = server.receive(batch);
      for (const recipient of recipients) recipient.receive(receipt.commit);
    }
  } });
  const peer = api.createClient(schema, { clientId: peerId, snapshot, onBatch() {} });
  recipients.push(doc, peer);
  const midpoint = Math.floor(size / 2);
  if (scenario === "pending-replay") {
    for (let index = 0; index < 20; index++) insert(doc, kind, midpoint);
  }
  const pendingBefore = doc.checkpoint().pendingBatches;
  // Construct the remote commit outside the receive-only measurement.
  const remote = scenario === "pending-replay" ? server.receive({ clientId: remoteId, seq: 1,
    operations: [{ type: "value/set", path: "count", value: 1 }] }).commit : undefined;
  const rounds = scenario === "pending-replay" ? 1 : iterations;
  let materialized: string | string[] | undefined;
  let saved: DocumentSnapshot<Shape> | undefined;
  collect();
  const start = performance.now();
  for (let index = 0; index < rounds; index++) {
    switch (scenario) {
      case "local-insert": case "sync-insert": insert(doc, kind, midpoint); break;
      case "local-delete":
        if (kind === "list") doc.state.items.delete(midpoint);
        else doc.state.body.delete(midpoint);
        break;
      case "pending-replay": doc.receive(remote!); break;
      case "materialize": materialized = kind === "list" ? doc.state.items.toArray() : doc.state.body.toString(); break;
      case "snapshot": saved = server.snapshot(); break;
      case "unused-policy-snapshot": case "unchanged-receive": {
        const receipt = server.receive({ clientId: remoteId, seq: index + 1,
          operations: [{ type: "value/set", path: "count", value: index + 1 }] });
        if (scenario === "unchanged-receive") doc.receive(receipt.commit);
        break;
      }
      case "retained-heap": throw new Error("Heap must be measured separately");
    }
  }
  const elapsed = (performance.now() - start) / rounds;

  // Assertions and serialization are not part of the measured work.
  const inserted = scenario === "pending-replay" ? 20 :
    scenario === "local-insert" || scenario === "sync-insert" ? rounds : 0;
  const deleted = scenario === "local-delete" ? rounds : 0;
  const count = scenario === "pending-replay" ? 1 : scenario === "unchanged-receive" ? rounds : 0;
  assert.deepEqual(visible(doc), expected(kind, size, count, inserted, deleted));
  assert.equal(doc.replayConflict, null);
  const checkpoint = doc.checkpoint();
  const pendingCount = scenario === "pending-replay" ? 20 :
    scenario === "local-insert" || scenario === "local-delete" ? rounds : 0;
  assert.equal(checkpoint.pendingBatches.length, pendingCount);
  if (scenario === "pending-replay") {
    assert.deepEqual(checkpoint.pendingBatches, pendingBefore);
    assert.equal(checkpoint.snapshot.serverSeq, 1);
    assert.deepEqual(checkpoint.snapshot, server.snapshot());
  } else if (scenario === "sync-insert") {
    assert.deepEqual(visible(peer), visible(doc));
    assert.deepEqual(checkpoint.snapshot, server.snapshot());
    assert.equal(checkpoint.snapshot.serverSeq, rounds);
    assert.equal(peer.checkpoint().pendingBatches.length, 0);
    assert.equal(batches.length, rounds);
  } else {
    assert.deepEqual(visible(peer), expected(kind, size));
    assert.equal(checkpoint.snapshot.serverSeq, scenario === "unchanged-receive" ? rounds : 0);
  }
  const serverCount = scenario === "pending-replay" ? 1 :
    scenario === "unused-policy-snapshot" || scenario === "unchanged-receive" ? rounds : 0;
  const serverSnapshot = server.snapshot();
  const data = serverSnapshot.data;
  assert.deepEqual({ count: data.count, items: data.items.values, body: data.body.value },
    expected(kind, size, serverCount, scenario === "sync-insert" ? rounds : 0));
  assert.equal(serverSnapshot.serverSeq, scenario === "pending-replay" ? 1 :
    ["sync-insert", "unused-policy-snapshot", "unchanged-receive"].includes(scenario) ? rounds : 0);
  if (materialized !== undefined) assert.deepEqual(materialized, kind === "list" ? data.items.values : data.body.value);
  if (saved !== undefined) assert.deepEqual(saved, serverSnapshot);
  assert.ok(Number.isFinite(elapsed) && elapsed >= 0);
  return elapsed;
}

function heapTrial(api: Api, kind: Kind, size: number): number {
  const schema = board(api);
  collect();
  const baseline = process.memoryUsage().heapUsed;
  const doc = api.createClient(schema, { clientId: "heap", snapshot: fixture(kind, size), onBatch() {} });
  collect();
  const retained = process.memoryUsage().heapUsed - baseline;
  // Keep the client alive through the measurement, but don't materialize it until afterwards.
  assert.deepEqual(visible(doc), expected(kind, size));
  assert.equal(doc.checkpoint().pendingBatches.length, 0);
  assert.equal(doc.checkpoint().snapshot.serverSeq, 0);
  assert.equal(doc.replayConflict, null);
  assert.ok(Number.isFinite(retained));
  return retained;
}

function serializedSizes(api: Api, kind: Kind, size: number) {
  const server = api.createServer(board(api), { historyLimit: 0,
    checkpoint: { snapshot: fixture(kind, size), lastClientNumber: 0, clients: [], history: [] } });
  return { snapshotBytes: Buffer.byteLength(JSON.stringify(server.snapshot()), "utf8"),
    checkpointBytes: Buffer.byteLength(JSON.stringify(server.checkpoint()), "utf8") };
}

function objectFixture(size: number) {
  return { serverSeq: 0, data: { items: {
    idList: [{ bunchId: "seed", startCounter: 0, count: size, isDeleted: false }],
    values: Array.from({ length: size }, () => ({ label: "x" })),
  } } };
}

function objectTrial(api: Api, size: number, scenario: typeof objectScenarios[number], iterations: number): number {
  const schema = api.defineDocument({ items: api.list<{ label: string }>() });
  const snapshot = objectFixture(size);
  const server = api.createServer(schema, { historyLimit: 0,
    checkpoint: { snapshot, lastClientNumber: 0, clients: [], history: [] } });
  const batches: ClientBatch<DocumentOperation<typeof schema.definition>>[] = [];
  const writer = api.createClient(schema, { clientId: server.openClient(), snapshot,
    onBatch: (batch) => batches.push(batch) });
  const peer = api.createClient(schema, { clientId: server.openClient(), snapshot, onBatch() {} });
  const observed = scenario === "object-remote-set-observed" || scenario === "object-remote-replace-observed";
  const recipient = scenario === "object-remote-replace" || scenario === "object-remote-set" || observed ? peer : writer;
  const isSet = scenario === "object-local-set" || scenario === "object-json-set-ack" || scenario === "object-remote-set" ||
    scenario === "object-remote-set-observed";
  let changes = 0;
  recipient.on("change", (event) => { if (event.origin === "server") changes++; });
  // Observed workloads keep a view mirror inside the timed receive, as a UI would.
  let mirror = observed ? recipient.state.items.toArray() : [];
  let notifications = 0;
  if (observed) recipient.state.items.observe((event) => {
    notifications++;
    for (const change of event.changes) {
      if (change.type === "set") mirror[change.index] = change.value;
      else mirror.splice(change.index, change.deleteCount, ...change.insert);
    }
  });
  collect();
  let elapsed = 0;
  for (let index = 0; index < iterations; index++) {
    const payload = { label: "y" };
    if (scenario === "object-json-ack") writer.state.items.push(payload);
    else if (isSet) {
      const start = scenario === "object-local-set" ? performance.now() : 0;
      writer.state.items.set(size - 1, payload);
      if (scenario === "object-local-set") elapsed += performance.now() - start;
    } else writer.transact(() => {
      writer.state.items.delete(size - 1);
      writer.state.items.insert(size - 1, payload);
    });
    const batch = batches[index]!;
    const received = server.receive(batch).commit;
    const commit = scenario === "object-json-ack" || scenario === "object-json-replace-ack" || scenario === "object-json-set-ack"
      ? api.decodeServerCommit(schema, JSON.parse(JSON.stringify(received))) : received;
    const start = scenario === "object-local-set" ? 0 : performance.now();
    recipient.receive(commit);
    if (scenario !== "object-local-set") elapsed += performance.now() - start;
    if (recipient === peer) writer.receive(commit);
    else peer.receive(commit);
    if (observed) {
      assert.equal(notifications, index + 1);
      assert.equal(mirror.length, size);
      assert.ok(Object.is(mirror[size - 1], recipient.state.items.get(size - 1)));
    }
    const operation = commit.operations.at(-1)!;
    assert.equal(operation.type, isSet ? "list/set" : "list/insert");
    if (operation.type === "list/insert" || operation.type === "list/set") {
      const position = scenario === "object-json-ack" ? size + index : size - 1;
      assert.strictEqual(recipient.state.items.get(position), operation.value);
      assert.equal(Object.is(operation.value, payload),
        scenario !== "object-json-ack" && scenario !== "object-json-replace-ack" && scenario !== "object-json-set-ack");
    }
  }
  assert.equal(changes, scenario === "object-own-replace-ack" || scenario === "object-local-set" ? 0 : iterations);
  const values = Array.from({ length: size }, () => ({ label: "x" }));
  if (scenario === "object-json-ack") values.push(...Array.from({ length: iterations }, () => ({ label: "y" })));
  else values[size - 1] = { label: "y" };
  for (const doc of [writer, peer]) {
    assert.deepEqual(doc.state.items.toArray(), values);
    assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
    assert.equal(doc.checkpoint().pendingBatches.length, 0);
    assert.equal(doc.replayConflict, null);
    if (isSet) {
      assert.deepEqual(doc.checkpoint().snapshot.data.items.idList, snapshot.data.items.idList);
      assert.equal(doc.checkpoint().lastBunchSeqs.items, 0);
    }
  }
  return elapsed / iterations;
}

function reconciliationFixture(kind: Kind, size: number, scenario: ReconciliationScenario) {
  const range = (bunchId: string) => [{ bunchId, startCounter: 0, count: size, isDeleted: false }];
  const hasText = kind === "text" || scenario === "object-json-mixed-ack";
  return { serverSeq: 0, data: {
    body: { idList: hasText ? range("text-seed") : [], value: hasText ? "x".repeat(size) : "" },
    items: { idList: kind === "list" ? range("list-seed") : [],
      values: kind === "list" ? Array.from({ length: size }, () => ({ label: "x" })) : [] },
    meta: null,
  } };
}

function reconciliationTrial(api: Api, kind: Kind, size: number,
  scenario: ReconciliationScenario, iterations: number): number {
  // Text comes first so another changed collection cannot hide an unnecessary Text scan.
  const schema = api.defineDocument({ body: api.text(), items: api.list<{ label: string }>(),
    meta: api.value<{ edited: number } | null>(null) });
  const snapshot = reconciliationFixture(kind, size, scenario);
  const server = api.createServer(schema, { historyLimit: 0,
    checkpoint: { snapshot, lastClientNumber: 0, clients: [], history: [] } });
  const batches: ClientBatch<DocumentOperation<typeof schema.definition>>[] = [];
  const writer = api.createClient(schema, { clientId: server.openClient(), snapshot,
    onBatch: (batch) => batches.push(batch) });
  const peer = api.createClient(schema, { clientId: server.openClient(), snapshot, onBatch() {} });
  const own = scenario.endsWith("mixed-ack"), samePath = scenario.endsWith("pending-same");
  const recipient = own ? writer : peer;
  if (!own) for (let index = 0; index < 20; index++) {
    if (!samePath) peer.state.meta.set({ edited: index });
    else if (kind === "list") peer.state.items.push({ label: "pending" });
    else peer.state.body.insert(peer.state.body.length, "P");
  }
  const before = recipient.checkpoint();
  let changes = 0, elapsed = 0;
  recipient.on("change", (event) => { if (event.origin === "server") changes++; });
  collect();
  for (let index = 0; index < iterations; index++) {
    writer.transact(() => {
      if (own) {
        writer.state.body.insert(writer.state.body.length, "😀");
        if (kind === "list") writer.state.items.set(size - 1, { label: String(index) });
        else writer.state.meta.set({ edited: index });
      } else if (kind === "text") {
        writer.state.body.delete(size - 1);
        writer.state.body.insert(size - 1, index % 2 === 0 ? "R" : "S");
      } else {
        if (scenario.startsWith("object-remote-replace")) {
          writer.state.items.delete(size - 1);
          writer.state.items.insert(size - 1, { label: String(index) });
        } else writer.state.items.set(size - 1, { label: String(index) });
      }
    });
    const commit = api.decodeServerCommit(schema, JSON.parse(JSON.stringify(server.receive(batches[index]!).commit)));
    if (!own) writer.receive(commit);
    const start = performance.now();
    recipient.receive(commit);
    elapsed += performance.now() - start;
    assert.equal(changes, index + 1);
    assert.equal(recipient.replayConflict, null);
    const operation = commit.operations.at(-1)!;
    if (operation.type === "list/set" || operation.type === "list/insert") {
      assert.strictEqual(recipient.state.items.get(size - 1), operation.value);
    } else if (operation.type === "value/set") assert.strictEqual(recipient.state.meta.value, operation.value);
  }
  const checkpoint = recipient.checkpoint();
  assert.deepEqual(checkpoint.snapshot, server.snapshot());
  assert.equal(checkpoint.snapshot.serverSeq, iterations);
  assert.equal(checkpoint.lastLocalSeq, own ? iterations : 20);
  assert.deepEqual(checkpoint.pendingBatches, own ? [] : before.pendingBatches);
  if (!own) assert.deepEqual(checkpoint.lastBunchSeqs, before.lastBunchSeqs);
  else assert.deepEqual(checkpoint.lastBunchSeqs, { body: 1, items: 0 });
  const items = kind === "list" ? Array.from({ length: size - 1 }, () => ({ label: "x" })) : [];
  if (kind === "list") items.push({ label: String(iterations - 1) });
  if (!own && samePath && kind === "list") items.push(...Array.from({ length: 20 }, () => ({ label: "pending" })));
  const body = own ? "x".repeat(size) + "😀".repeat(iterations) : kind === "text"
    ? "x".repeat(size - 1) + (iterations % 2 === 0 ? "S" : "R") + (samePath ? "P".repeat(20) : "") : "";
  assert.deepEqual(recipient.state.items.toArray(), items);
  assert.equal(recipient.state.body.toString(), body);
  assert.deepEqual(recipient.state.meta.value, own ? kind === "text" ? { edited: iterations - 1 } : null
    : samePath ? null : { edited: 19 });
  return elapsed / iterations;
}

function fragmentedFixture(api: Api, size: number) {
  const schema = board(api), server = api.createServer(schema, { historyLimit: 0 });
  const doc = api.createClient(schema, { clientId: server.openClient(),
    onBatch(batch) { doc.receive(server.receive(batch).commit); } });
  const oracle: string[] = [];
  let seed = 42;
  const choose = (bound: number) => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const deleted = Math.floor(size / 4);
  doc.transact(() => {
    for (let index = 0; index < size + deleted; index++) {
      const position = choose(oracle.length + 1), value = (index + 1) % 11 === 0 ? "😀" : "x";
      doc.state.body.insert(position, value);
      oracle.splice(position, 0, value);
    }
  });
  doc.transact(() => {
    for (let index = 0; index < deleted; index++) {
      const position = choose(oracle.length);
      doc.state.body.delete(position);
      oracle.splice(position, 1);
    }
  });
  assert.equal(doc.state.body.toString(), oracle.join(""));
  assert.equal(doc.state.body.length, size);
  assert.equal(doc.replayConflict, null);
  const checkpoint = doc.checkpoint(), snapshot = server.snapshot();
  assert.deepEqual(checkpoint.snapshot, snapshot);
  assert.equal(checkpoint.pendingBatches.length, 0);
  const remoteId = server.openClient();
  const ranges = snapshot.data.body.idList;
  const tombstone = ranges.find((range) => range.isDeleted);
  assert.ok(tombstone !== undefined);
  const snapshotJson = JSON.stringify(snapshot), serverJson = JSON.stringify(server.checkpoint());
  const stats: FixtureStats = { seed: 42, visibleIds: size,
    deletedIds: ranges.filter((range) => range.isDeleted).reduce((sum, range) => sum + range.count, 0),
    savedRanges: ranges.length, bunches: new Set(ranges.map((range) => range.bunchId)).size,
    snapshotSha256: createHash("sha256").update(snapshotJson).digest("hex") };
  assert.equal(stats.deletedIds, deleted);
  return { snapshotJson, serverJson, clientJson: JSON.stringify(checkpoint), value: oracle.join(""),
    watermark: snapshot.serverSeq, remoteId, stats,
    tombstone: { bunchId: tombstone.bunchId, counter: tombstone.startCounter },
    snapshotBytes: Buffer.byteLength(snapshotJson, "utf8"), checkpointBytes: Buffer.byteLength(serverJson, "utf8") };
}

function fragmentedTrial(api: Api, fragment: ReturnType<typeof fragmentedFixture>,
  scenario: ExtendedScenario, iterations: number): number {
  const schema = board(api);
  // JSON parsing is outside decode+restore and heap measurements; no preloaded state is reused.
  if (scenario === "server-decode-restore") {
    const input: unknown = JSON.parse(fragment.serverJson);
    collect();
    const start = performance.now();
    const server = api.createServer(schema, { historyLimit: 0,
      checkpoint: api.decodeServerCheckpoint(schema, input) });
    const elapsed = performance.now() - start;
    assert.equal(server.snapshot().data.body.value, fragment.value);
    assert.deepEqual(server.checkpoint(), JSON.parse(fragment.serverJson));
    return elapsed;
  }
  if (scenario === "client-decode-restore" || scenario === "retained-heap") {
    const input: unknown = JSON.parse(fragment.clientJson);
    collect();
    const baseline = process.memoryUsage().heapUsed, start = performance.now();
    const doc = api.createClient(schema, { clientId: "client-1",
      checkpoint: api.decodeClientCheckpoint(schema, input), onBatch() {} });
    const elapsed = performance.now() - start;
    if (scenario === "retained-heap") collect();
    const retained = process.memoryUsage().heapUsed - baseline;
    assert.equal(doc.state.body.toString(), fragment.value);
    assert.equal(doc.replayConflict, null);
    assert.deepEqual(doc.checkpoint(), input);
    return scenario === "retained-heap" ? retained : elapsed;
  }
  const trial = prepareFragmentedEdit(api, fragment, scenario, iterations);
  collect();
  const start = performance.now();
  trial.run();
  const elapsed = (performance.now() - start) / trial.rounds;
  trial.verify();
  return elapsed;
}

function prepareFragmentedEdit(api: Api, fragment: ReturnType<typeof fragmentedFixture>,
  scenario: ExtendedScenario, iterations: number) {
  const schema = board(api);
  // Raw snapshots load afresh for each trial, outside receive/local-edit timing.
  const snapshot = api.decodeSnapshot(schema, JSON.parse(fragment.snapshotJson));
  const batches: Batch[] = [];
  const doc = api.createClient(schema, { clientId: "client-3", snapshot,
    onBatch(batch) { batches.push(batch); } });
  let localChanges = 0, serverChanges = 0;
  doc.on("change", (event) => { if (event.origin === "local") localChanges++; else serverChanges++; });
  const points = Array.from(fragment.value), midpoint = Math.floor(points.length / 2);
  const rounds = scenario === "bulk-delete" || scenario === "pending-replay" ? 1 : iterations;
  const commits: ServerCommit<DocumentOperation<Shape>>[] = [];
  if (scenario === "pending-replay") {
    for (let index = 0; index < 20; index++) doc.state.body.insert(doc.state.body.length, "P");
  }
  if (scenario.startsWith("remote-") || scenario === "pending-replay") {
    const server = api.createServer(schema, { historyLimit: 0,
      checkpoint: api.decodeServerCheckpoint(schema, JSON.parse(fragment.serverJson)) });
    const remote = api.createClient(schema, { clientId: fragment.remoteId, snapshot,
      onBatch(batch) { const commit = server.receive(batch).commit; commits.push(commit); remote.receive(commit); } });
    for (let index = 0; index < rounds; index++) {
      if (scenario === "remote-noop-delete") {
        commits.push(server.receive({ clientId: fragment.remoteId, seq: index + 1,
          operations: [{ type: "text/delete", path: "body", ranges: [{ start: fragment.tombstone, count: 1 }] }] }).commit);
      } else if (scenario === "pending-replay") remote.state.body.insert(0, "R");
      else remote.transact(() => {
        remote.state.body.delete(remote.state.body.length - 1);
        remote.state.body.insert(remote.state.body.length, index % 2 === 0 ? "R" : "S");
      });
    }
  }
  const before = doc.checkpoint();
  return { rounds, run() {
    for (let index = 0; index < rounds; index++) {
      if (scenario === "local-insert") doc.state.body.insert(midpoint, "😀");
      else if (scenario === "local-delete") doc.state.body.delete(midpoint);
      else if (scenario === "bulk-delete") doc.state.body.delete(0, Math.floor(points.length / 2));
      else doc.receive(commits[index]!);
    }
  }, verify() {
    if (scenario === "local-insert") points.splice(midpoint, 0, ...Array<string>(rounds).fill("😀"));
    else if (scenario === "local-delete") points.splice(midpoint, rounds);
    else if (scenario === "bulk-delete") points.splice(0, Math.floor(points.length / 2));
    else if (scenario === "remote-replace") points[points.length - 1] = rounds % 2 === 0 ? "S" : "R";
    else if (scenario === "pending-replay") { points.unshift("R"); points.push(...Array<string>(20).fill("P")); }
    assert.equal(doc.state.body.toString(), points.join(""));
    assert.equal(doc.state.body.length, points.length);
    assert.equal(doc.replayConflict, null);
    const checkpoint = doc.checkpoint(), local = scenario.startsWith("local-") || scenario === "bulk-delete";
    assert.equal(checkpoint.snapshot.serverSeq, fragment.watermark + (local ? 0 : rounds));
    assert.equal(checkpoint.snapshot.data.body.value, local ? fragment.value :
      scenario === "pending-replay" ? "R" + fragment.value : points.join(""));
    assert.equal(checkpoint.pendingBatches.length, scenario === "pending-replay" ? 20 : local ? rounds : 0);
    assert.equal(localChanges, scenario === "pending-replay" ? 20 : local ? rounds : 0);
    assert.equal(serverChanges, scenario === "remote-replace" || scenario === "pending-replay" ? rounds : 0);
    if (!local) {
      assert.deepEqual(checkpoint.pendingBatches, before.pendingBatches);
      assert.deepEqual(checkpoint.lastBunchSeqs, before.lastBunchSeqs);
      assert.equal(checkpoint.lastLocalSeq, before.lastLocalSeq);
    } else {
      assert.deepEqual(checkpoint.pendingBatches, batches);
      assert.equal(checkpoint.lastLocalSeq, rounds);
      assert.equal(checkpoint.snapshot.data.body.value, fragment.value);
    }
  } };
}

function historyFixture(api: Api, limit: number) {
  const schema = board(api), server = api.createServer(schema, { historyLimit: 0 });
  const clientId = server.openClient(), history: ServerCommit<DocumentOperation<Shape>>[] = [];
  for (let seq = 1; seq <= limit; seq++) history.push(server.receive({ clientId, seq,
    operations: [{ type: "value/set", path: "count", value: seq }] }).commit);
  // Build a legal, full suffix without repeatedly copying history during prefill.
  return JSON.stringify({ ...server.checkpoint(), history });
}

function historyTrial(api: Api, checkpointJson: string, limit: number, iterations: number): number {
  const schema = board(api), checkpoint = api.decodeServerCheckpoint(schema, JSON.parse(checkpointJson));
  const server = api.createServer(schema, { historyLimit: limit, checkpoint });
  const batches: Batch[] = Array.from({ length: iterations }, (_, index) => ({ clientId: "client-1",
    seq: limit + index + 1, operations: [{ type: "value/set", path: "count", value: limit + index + 1 }] }));
  collect();
  const start = performance.now();
  for (const batch of batches) server.receive(batch);
  const elapsed = (performance.now() - start) / iterations;
  const end = limit + iterations, saved = server.checkpoint();
  assert.equal(saved.snapshot.serverSeq, end);
  assert.equal(saved.snapshot.data.count, end);
  assert.equal(saved.history.length, limit);
  assert.equal(saved.clients[0]!.replay!.batch.seq, end);
  assert.equal(server.receive(batches.at(-1)!).replayed, true);
  assert.deepEqual(server.checkpoint(), saved);
  assert.deepEqual(server.commitsSince(end), []);
  assert.equal(server.commitsSince(end - limit - 1), null);
  const suffix = server.commitsSince(end - limit);
  assert.ok(suffix !== null);
  assert.deepEqual(suffix.map((commit) => commit.serverSeq), Array.from({ length: limit }, (_, index) => iterations + index + 1));
  return elapsed;
}

function summarizeProfile(profile: Profiler.Profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const groups = { authoritativeApply: 0, visibleEquality: 0, otherRuntime: 0, gc: 0, profilerOrUnattributed: 0 };
  const equality = { idIteration: 0, keyEncoding: 0, hamtLookup: 0, other: 0 };
  const functions = new Map<string, { functionName: string; url: string; lineNumber: number;
    columnNumber: number; selfMicros: number; inclusiveMicros: number }>();
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  assert.equal(samples.length, deltas.length, "CPU profile samples and deltas must align");
  let totalSampleMicros = 0;
  for (const [index, sample] of samples.entries()) {
    const weight = deltas[index]!;
    assert.ok(Number.isFinite(weight) && weight >= 0);
    const stack: Profiler.ProfileNode[] = [];
    for (let id: number | undefined = sample; id !== undefined; id = parents.get(id)) {
      const node = nodes.get(id);
      assert.ok(node !== undefined);
      stack.push(node);
    }
    const top = stack[0]!.callFrame;
    totalSampleMicros += weight;
    const seen = new Set<string>();
    for (const [depth, node] of stack.entries()) {
      const { functionName, url, lineNumber, columnNumber } = node.callFrame;
      const key = JSON.stringify([functionName, url, lineNumber, columnNumber]);
      const row = functions.get(key) ?? { functionName, url, lineNumber, columnNumber, selfMicros: 0, inclusiveMicros: 0 };
      if (depth === 0) row.selfMicros += weight;
      // A recursive function is inclusive once per sample, not once per frame.
      if (!seen.has(key)) row.inclusiveMicros += weight;
      seen.add(key);
      functions.set(key, row);
    }
    const has = (name: string, suffix: string) => stack.some(({ callFrame }) =>
      callFrame.functionName === name && callFrame.url.endsWith(suffix));
    if (top.functionName === "(garbage collector)") groups.gc += weight;
    else if (has("visibleEquals", "/dist/text.js")) {
      groups.visibleEquality += weight;
      if (top.url.endsWith("/dist/vendor/hamt.js")) equality.hamtLookup += weight;
      else if (top.functionName === "idKey" && top.url.endsWith("/dist/text.js") ||
        has("idKey", "/dist/text.js") && top.functionName === "stringify") equality.keyEncoding += weight;
      else if (top.url.includes("/articulated/")) equality.idIteration += weight;
      else equality.other += weight;
    } else if (has("applyOperations", "/dist/state.js")) groups.authoritativeApply += weight;
    else if (top.url.includes("/dist/") || top.url.includes("/articulated/")) groups.otherRuntime += weight;
    else groups.profilerOrUnattributed += weight;
  }
  assert.equal(Object.values(groups).reduce((sum, value) => sum + value, 0), totalSampleMicros);
  assert.equal(Object.values(equality).reduce((sum, value) => sum + value, 0), groups.visibleEquality);
  const percent = (value: number, total: number) => total === 0 ? 0 : value / total * 100;
  return { sampleCount: samples.length, totalSampleMicros, durationMicros: profile.endTime - profile.startTime,
    groups, equality,
    groupPercent: Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, percent(value, totalSampleMicros)])),
    equalityPercentOfEquality: Object.fromEntries(Object.entries(equality).map(([key, value]) => [key, percent(value, groups.visibleEquality)])),
    functions: [...functions.values()].toSorted((left, right) => right.selfMicros - left.selfMicros).map((row) =>
      ({ ...row, selfPercent: percent(row.selfMicros, totalSampleMicros), inclusivePercent: percent(row.inclusiveMicros, totalSampleMicros) })),
    note: "Microsecond-weighted samples are estimates, not exact CPU time. Groups are exclusive; equality details partition visibleEquality. Inclusive function times overlap and must not be summed. Inlining/unrecognized frames remain unattributed." };
}

async function profileDirectory(directory: string): Promise<string> {
  const target = await realpath(directory), checkout = await realpath(root);
  assert.ok((await stat(target)).isDirectory(), "Profile output must be an existing directory");
  const location = relative(checkout, target);
  assert.ok(location === ".." || location.startsWith(".." + sep) || isAbsolute(location),
    "Profile output must be outside the checkout");
  return target;
}

async function profiledWorker(size: number, smoke: boolean, directory: string) {
  const loaded: unknown = await import(import.meta.resolve("articollab"));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Built self-package matches the source API, as for the existing benchmark workers.
  const api = loaded as Api;
  const config = extendedSettings(smoke), fragment = fragmentedFixture(api, size);
  for (let index = 0; index < config.warmups; index++) fragmentedTrial(api, fragment, "remote-replace", config.iterations);
  const profiles: { profile: string; summary: string; wallMsPerOp: number }[] = [];
  for (let index = 0; index < config.samples; index++) {
    const trial = prepareFragmentedEdit(api, fragment, "remote-replace", config.iterations);
    const session = new Session();
    let active = false, disconnectFailed = false, disconnectError: unknown;
    let captured: Profiler.Profile, elapsed: number;
    try {
      session.connect();
      await session.post("Profiler.enable");
      await session.post("Profiler.setSamplingInterval", { interval: 1000 });
      collect();
      await session.post("Profiler.start");
      active = true;
      const start = performance.now();
      trial.run();
      elapsed = (performance.now() - start) / trial.rounds;
      captured = (await session.post("Profiler.stop")).profile;
      active = false;
    } catch (error) {
      if (active) { try { await session.post("Profiler.stop"); } catch { /* Preserve the first failure. */ } }
      throw error;
    } finally {
      try { session.disconnect(); } catch (error) { disconnectFailed = true; disconnectError = error; }
    }
    if (disconnectFailed) throw disconnectError;
    // No assertions, summary work or file writes while the profiler is running.
    trial.verify();
    const profile = `text-${size}-${index + 1}.cpuprofile`, summary = `text-${size}-${index + 1}.summary.json`;
    await writeFile(join(directory, profile), JSON.stringify(captured), { flag: "wx" });
    await writeFile(join(directory, summary), JSON.stringify(summarizeProfile(captured), null, 2), { flag: "wx" });
    profiles.push({ profile, summary, wallMsPerOp: elapsed });
  }
  return { kind: "text", size, scenario: "remote-replace", fixture: fragment.stats,
    snapshotBytes: fragment.snapshotBytes, checkpointBytes: fragment.checkpointBytes,
    operationsPerSample: config.iterations, profiles };
}

async function profileRemoteReplace(parent: string, smoke: boolean, json: boolean) {
  const directory = await mkdtemp(join(await profileDirectory(parent), "articollab-text-profile-"));
  const environment = await metadata(), config = extendedSettings(smoke);
  const results: { control: ExtendedResult; profiled: Awaited<ReturnType<typeof profiledWorker>> }[] = [];
  const runWorker = async (args: string[]) => {
    try {
      const output = await execute(process.execPath, ["--expose-gc", filename, ...args],
        { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 });
      assert.equal(output.stderr, "");
      return output.stdout;
    } catch (cause) {
      const stderr = cause instanceof Error && "stderr" in cause && typeof cause.stderr === "string" ? cause.stderr : "";
      try {
        await writeFile(join(directory, "failure.txt"), `${args.join(" ")}\n${String(cause)}\n${stderr}`, { flag: "wx" });
      } catch { /* Artifact cleanup/output must not replace the worker failure. */ }
      throw new Error(`Profile worker failed; artifacts retained in ${directory}\n${stderr}`, { cause });
    }
  };
  for (const size of config.sizes) {
    const mode = smoke ? "smoke" : "full";
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The existing private worker constructs ExtendedResult; smoke tests validate the manifest.
    const control = JSON.parse(await runWorker(["--extended-worker", "text", String(size), "remote-replace", mode])) as ExtendedResult;
    await writeFile(join(directory, `control-${size}.json`), JSON.stringify(control, null, 2), { flag: "wx" });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The private profile worker constructs this return type; smoke tests inspect every artifact.
    const profiled = JSON.parse(await runWorker(["--profile-worker", String(size), mode, directory])) as Awaited<ReturnType<typeof profiledWorker>>;
    assert.deepEqual(profiled.fixture, control.fixture);
    assert.equal(profiled.snapshotBytes, control.snapshotBytes);
    assert.equal(profiled.checkpointBytes, control.checkpointBytes);
    results.push({ control, profiled });
  }
  const manifest = { directory, environment, config: { sizes: config.sizes, samples: config.samples,
    iterations: config.iterations, warmups: config.warmups, seed: 42, samplingIntervalMicros: 1000 }, results,
    note: "Only synchronous receive loops are profiled; setup, explicit GC, assertions and output are excluded. Profiler start/stop overhead and unrecognized frames may still be sampled. Profiled wall times are not control timings or an SLA." };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  if (json) console.log(JSON.stringify(manifest, null, 2));
  else console.log(`Receive-only Text profiles: ${directory}\n${results.length} sizes; control and profiled wall times are separate. See manifest.json and *.summary.json. Sampling estimates are not an SLA.`);
}

async function extendedWorker(kind: "text" | "history", size: number,
  scenario: ExtendedResult["scenario"], smoke: boolean): Promise<ExtendedResult> {
  const loaded: unknown = await import(import.meta.resolve("articollab"));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Built self-package has the API checked against source types.
  const api = loaded as Api;
  const config = extendedSettings(smoke);
  const fragment = kind === "text" ? fragmentedFixture(api, size) : undefined;
  const history = kind === "history" ? historyFixture(api, size) : undefined;
  const once = ["bulk-delete", "pending-replay", "client-decode-restore", "server-decode-restore", "retained-heap"].includes(scenario);
  const operationsPerSample = once ? 1 : config.iterations;
  const trial = () => {
    if (history !== undefined) return historyTrial(api, history, size, operationsPerSample);
    assert.ok(fragment !== undefined && scenario !== "history-receive");
    return fragmentedTrial(api, fragment, scenario, operationsPerSample);
  };
  for (let index = 0; index < config.warmups; index++) trial();
  const samples = Array.from({ length: config.samples }, trial), sorted = samples.toSorted((a, b) => a - b);
  assert.ok(samples.every((sample) => Number.isFinite(sample) && (scenario === "retained-heap" || sample >= 0)));
  const midpoint = Math.floor(sorted.length / 2);
  return { kind, size, scenario, unit: scenario === "retained-heap" ? "bytes" : "ms/op", operationsPerSample,
    samples, min: sorted[0]!, max: sorted.at(-1)!,
    median: sorted.length % 2 === 0 ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2 : sorted[midpoint]!,
    ...(fragment === undefined ? {
      snapshotBytes: Buffer.byteLength(JSON.stringify(api.decodeServerCheckpoint(board(api), JSON.parse(history!)).snapshot), "utf8"),
      checkpointBytes: Buffer.byteLength(history!, "utf8"),
    } : { snapshotBytes: fragment.snapshotBytes, checkpointBytes: fragment.checkpointBytes, fixture: fragment.stats }) };
}

async function worker(kind: Kind, size: number, scenario: Scenario, smoke: boolean): Promise<Result> {
  // Type-only source references allow check-before-build; runtime always resolves production ESM.
  const loaded: unknown = await import(import.meta.resolve("articollab"));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Self-package resolution points to the built public entrypoint generated from the same source API.
  const api = loaded as Api;
  const config = settings(smoke);
  const objectScenario = objectScenarios.find((candidate) => candidate === scenario);
  assert.ok(objectScenario === undefined || kind === "list", "Object workloads require List");
  const reconciliationScenario = (kind === "list" ? pendingListScenarios : pendingTextScenarios)
    .find((candidate) => candidate === scenario);
  const objectSnapshot = reconciliationScenario === undefined
    ? objectScenario === undefined ? undefined : objectFixture(size)
    : reconciliationFixture(kind, size, reconciliationScenario);
  const bytes = objectSnapshot === undefined ? serializedSizes(api, kind, size) : {
    snapshotBytes: Buffer.byteLength(JSON.stringify(objectSnapshot), "utf8"),
    checkpointBytes: Buffer.byteLength(JSON.stringify({ snapshot: objectSnapshot,
      lastClientNumber: 0, clients: [], history: [] }), "utf8"),
  };
  const trial = () => {
    if (reconciliationScenario !== undefined) return reconciliationTrial(api, kind, size, reconciliationScenario, config.iterations);
    if (objectScenario !== undefined) return objectTrial(api, size, objectScenario, config.iterations);
    if (scenario === "retained-heap") return heapTrial(api, kind, size);
    const primitiveScenario = scenarios.find((candidate) => candidate === scenario);
    assert.ok(primitiveScenario !== undefined);
    return timeTrial(api, kind, size, primitiveScenario, config.iterations);
  };
  for (let index = 0; index < config.warmups; index++) trial();
  const samples = Array.from({ length: config.samples }, trial);
  const sorted = samples.toSorted((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return { kind, size, scenario, unit: scenario === "retained-heap" ? "bytes" : "ms/op",
    operationsPerSample: scenario === "retained-heap" || scenario === "pending-replay" ? 1 : config.iterations,
    samples, median: sorted.length % 2 === 0 ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2 : sorted[midpoint]!,
    min: sorted[0]!, max: sorted[sorted.length - 1]!, ...bytes };
}

async function metadata() {
  const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const dependency: unknown = JSON.parse(await readFile(join(root, "node_modules/articulated/package.json"), "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string");
  assert.ok(typeof dependency === "object" && dependency !== null && "version" in dependency && typeof dependency.version === "string");
  const sha = await execute("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5_000 });
  const status = await execute("git", ["status", "--porcelain"], { cwd: root, timeout: 5_000 });
  return { node: process.version, v8: process.versions.v8, os: platform(), osRelease: release(),
    architecture: arch(), cpu: cpus()[0]?.model ?? "unknown", cpuCount: cpus().length,
    packageVersion: manifest.version, articulatedVersion: dependency.version,
    gitSha: sha.stdout.trim(), dirty: status.stdout.length > 0 };
}

async function main(args: string[]): Promise<void> {
  if (args[0] === "--profile-worker") {
    const size = Number(args[1]), smoke = args[2] === "smoke";
    assert.ok(args.length === 4 && (smoke || args[2] === "full") &&
      extendedSettings(smoke).sizes.includes(size), "Invalid profile worker arguments");
    const directory = await profileDirectory(args[3]!);
    console.log(JSON.stringify(await profiledWorker(size, smoke, directory)));
    return;
  }
  if (args[0] === "--extended-worker") {
    const kind = args[1], size = Number(args[2]);
    const scenario = [...extendedScenarios, "history-receive" as const].find((candidate) => candidate === args[3]);
    assert.ok(args.length === 5 && (kind === "text" || kind === "history") && scenario !== undefined &&
      (args[4] === "smoke" || args[4] === "full"), "Invalid extended worker arguments");
    const smoke = args[4] === "smoke", config = extendedSettings(smoke);
    assert.ok(kind === "history" ? scenario === "history-receive" && config.historyLimits.includes(size) :
      scenario !== "history-receive" && config.sizes.includes(size), "Invalid extended workload");
    console.log(JSON.stringify(await extendedWorker(kind, size, scenario, smoke)));
    return;
  }
  if (args[0] === "--worker") {
    const kind = kinds.find((candidate) => candidate === args[1]);
    const scenario = [...scenarios, ...(kind === "list" ? [...objectScenarios, ...pendingListScenarios] : pendingTextScenarios)]
      .find((candidate) => candidate === args[3]);
    const size = Number(args[2]);
    assert.ok(args.length === 5 && kind !== undefined && scenario !== undefined &&
      (args[4] === "smoke" || args[4] === "full"), "Invalid benchmark worker arguments");
    const smoke = args[4] === "smoke";
    assert.ok(settings(smoke).sizes.includes(size), "Invalid benchmark size");
    console.log(JSON.stringify(await worker(kind, size, scenario, smoke)));
    return;
  }
  const { values } = parseArgs({ args, options: { json: { type: "boolean" }, smoke: { type: "boolean" },
    extended: { type: "boolean" }, "profile-remote-replace": { type: "string" } } });
  if (values["profile-remote-replace"] !== undefined) {
    assert.ok(!values.extended, "Profiling and --extended are separate modes");
    assert.ok(values["profile-remote-replace"].length > 0, "Profile output directory must not be empty");
    await profileRemoteReplace(values["profile-remote-replace"], values.smoke === true, values.json === true);
    return;
  }
  const config = values.extended ? extendedSettings(values.smoke === true) : settings(values.smoke === true);
  const environment = await metadata();
  const results: (Result | ExtendedResult)[] = [];
  if (values.extended) {
    const extended = extendedSettings(values.smoke === true);
    const workloads = [
      ...extended.sizes.flatMap((size) => extendedScenarios.map((scenario) => ({ kind: "text", size, scenario }))),
      ...extended.historyLimits.map((size) => ({ kind: "history", size, scenario: "history-receive" })),
    ];
    for (const { kind, size, scenario } of workloads) {
      try {
        const output = await execute(process.execPath, ["--expose-gc", filename, "--extended-worker", kind,
          String(size), scenario, values.smoke ? "smoke" : "full"],
        { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 });
        assert.equal(output.stderr, "");
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Private worker constructs this result; smoke tests validate its report.
        results.push(JSON.parse(output.stdout) as ExtendedResult);
      } catch (cause) {
        const stderr = cause instanceof Error && "stderr" in cause && typeof cause.stderr === "string" ? cause.stderr : "";
        throw new Error(`extended/${kind}/${size}/${scenario} worker failed\n${stderr}`, { cause });
      }
    }
  } else for (const kind of kinds) {
    for (const size of config.sizes) {
      for (const scenario of [...scenarios, ...(kind === "list" ? [...objectScenarios, ...pendingListScenarios] : pendingTextScenarios)]) {
        const workerArgs = ["--expose-gc", filename, "--worker", kind, String(size), scenario,
          values.smoke ? "smoke" : "full"];
        try {
          const output = await execute(process.execPath, workerArgs, { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 });
          assert.equal(output.stderr, "");
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This private worker emits the Result constructed above; smoke tests validate the full output schema.
          results.push(JSON.parse(output.stdout) as Result);
        } catch (cause) {
          const stderr = cause instanceof Error && "stderr" in cause && typeof cause.stderr === "string" ? cause.stderr : "";
          throw new Error(`${kind}/${size}/${scenario} worker failed\n${stderr}`, { cause });
        }
      }
    }
  }
  if (values.json) {
    console.log(JSON.stringify({ environment, config, results }, null, 2));
  } else {
    console.log(`Articollab ${environment.packageVersion} · ${environment.node} · ${environment.os}/${environment.architecture}`);
    console.log(`CPU: ${environment.cpu} · SHA: ${environment.gitSha}${environment.dirty ? " (dirty)" : ""}`);
    console.log("kind\tsize\tscenario\tmedian\tmin\tmax\tunit\tsnapshot B\tcheckpoint B");
    for (const row of results) {
      const digits = row.unit === "bytes" ? 0 : 3;
      console.log([row.kind, row.size, row.scenario, row.median.toFixed(digits), row.min.toFixed(digits),
        row.max.toFixed(digits), row.unit, row.snapshotBytes, row.checkpointBytes].join("\t"));
    }
    if (values.extended) console.log("Extended: text size is visible code points; history size is commit capacity. Restore measures decode + constructor, excluding JSON.parse.");
    console.log("Retained heap is a signed GC estimate, not peak memory, allocations or RSS. Results are not an SLA.");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
