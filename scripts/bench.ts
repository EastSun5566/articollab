import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import type {
  ClientBatch, ClientDocument, DocumentOperation, DocumentSnapshot,
  ListSchema, TextSchema, ValueSchema,
} from "../src/index.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const filename = fileURLToPath(import.meta.url);
const execute = promisify(execFile);
const kinds = ["list", "text"] as const;
const scenarios = ["local-insert", "local-delete", "sync-insert", "pending-replay",
  "materialize", "snapshot", "unused-policy-snapshot", "unchanged-receive", "retained-heap"] as const;
type Kind = typeof kinds[number];
type Scenario = typeof scenarios[number];
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

function timeTrial(api: Api, kind: Kind, size: number, scenario: Scenario, iterations: number): number {
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

async function worker(kind: Kind, size: number, scenario: Scenario, smoke: boolean): Promise<Result> {
  // Type-only source references allow check-before-build; runtime always resolves production ESM.
  const loaded: unknown = await import(import.meta.resolve("articollab"));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Self-package resolution points to the built public entrypoint generated from the same source API.
  const api = loaded as Api;
  const config = settings(smoke);
  const bytes = serializedSizes(api, kind, size);
  const trial = () => scenario === "retained-heap" ? heapTrial(api, kind, size) :
    timeTrial(api, kind, size, scenario, config.iterations);
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
  if (args[0] === "--worker") {
    const kind = kinds.find((candidate) => candidate === args[1]);
    const scenario = scenarios.find((candidate) => candidate === args[3]);
    const size = Number(args[2]);
    assert.ok(args.length === 5 && kind !== undefined && scenario !== undefined &&
      (args[4] === "smoke" || args[4] === "full"), "Invalid benchmark worker arguments");
    const smoke = args[4] === "smoke";
    assert.ok(settings(smoke).sizes.includes(size), "Invalid benchmark size");
    console.log(JSON.stringify(await worker(kind, size, scenario, smoke)));
    return;
  }
  const { values } = parseArgs({ args, options: { json: { type: "boolean" }, smoke: { type: "boolean" } } });
  const config = settings(values.smoke === true);
  const environment = await metadata();
  const results: Result[] = [];
  for (const kind of kinds) {
    for (const size of config.sizes) {
      for (const scenario of scenarios) {
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
    console.log("Retained heap is a signed GC estimate, not peak memory, allocations or RSS. Results are not an SLA.");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
