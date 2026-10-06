import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));
const env = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;

async function run(command: string, args: string[], cwd: string, timeout = 15_000) {
  try {
    return await execute(command, args, { cwd, env, timeout, maxBuffer: 1024 * 1024 });
  } catch (cause) {
    const stdout = cause instanceof Error && "stdout" in cause && typeof cause.stdout === "string" ? cause.stdout : "";
    const stderr = cause instanceof Error && "stderr" in cause && typeof cause.stderr === "string" ? cause.stderr : "";
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${stdout}\n${stderr}`,
      { cause });
  }
}

function pnpm(args: string[], cwd: string, timeout?: number) {
  const cli = process.env.npm_execpath;
  return cli ? run(process.execPath, [cli, ...args], cwd, timeout) : run("pnpm", args, cwd, timeout);
}

function record(input: unknown): Record<string, unknown> {
  assert.ok(input !== null && typeof input === "object" && !Array.isArray(input));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Container checked above; every field remains unknown.
  return input as Record<string, unknown>;
}

async function json(path: string): Promise<Record<string, unknown>> {
  return record(JSON.parse(await readFile(path, "utf8")));
}

const runtimeFixture = `
import assert from "node:assert/strict";
import {
  createClient, createServer, defineDocument, list, text, value,
  decodeClientBatch, decodeServerCommit, decodeClientCheckpoint, decodeServerCheckpoint,
} from "articollab";

const Board = defineDocument({ count: value(0), items: list(), body: text() });
const roundTrip = (input) => JSON.parse(JSON.stringify(input));
const visible = (doc) => ({ count: doc.state.count.value,
  items: doc.state.items.toArray(), body: doc.state.body.toString() });
let server = createServer(Board);
const outgoing = [];
let source = createClient(Board, { clientId: "source", onBatch: (batch) => outgoing.push(batch) });
const peer = createClient(Board, { clientId: "peer", onBatch() {} });
const insertionIds = new Set();
function submit(batch) {
  for (const operation of batch.operations) {
    if (operation.type !== "list/insert" && operation.type !== "text/insert") continue;
    const count = operation.type === "text/insert" ? [...operation.value].length : 1;
    for (let offset = 0; offset < count; offset++) {
      const key = JSON.stringify([operation.id.bunchId, operation.id.counter + offset]);
      assert.ok(!insertionIds.has(key), "insertion IDs must not be reused after restore");
      insertionIds.add(key);
    }
  }
  const receipt = server.receive(decodeClientBatch(Board, roundTrip(batch)));
  for (const doc of [source, peer]) doc.receive(decodeServerCommit(Board, roundTrip(receipt.commit)));
  return receipt.commit;
}

let localChanges = 0;
source.on("change", ({ origin }) => { if (origin === "local") localChanges++; });
source.transact(() => {
  source.state.count.value = 1;
  source.state.items.push("first");
  source.state.body.insert(0, "A😀");
});
assert.equal(outgoing.length, 1);
assert.equal(localChanges, 1);
assert.equal(outgoing[0].operations.length, 3);
assert.equal(source.state.body.length, 2);
assert.deepEqual(visible(source), { count: 1, items: ["first"], body: "A😀" });
assert.deepEqual(visible(peer), { count: 0, items: [], body: "" });
assert.equal(submit(outgoing[0]).serverSeq, 1);
assert.deepEqual(visible(source), visible(peer));

source.transact(() => {
  source.state.count.value = 2;
  source.state.items.push("pending");
  source.state.body.insert(source.state.body.length, "B");
});
const savedClient = decodeClientCheckpoint(Board, roundTrip(source.checkpoint()));
const savedServer = decodeServerCheckpoint(Board, roundTrip(server.checkpoint()));
assert.equal(savedClient.pendingBatches.length, 1);
assert.equal(savedClient.pendingBatches[0].seq, 2);
assert.equal(savedClient.snapshot.serverSeq, 1);
const beforeRestore = visible(source);
const restoredOutgoing = [];
server = createServer(Board, { checkpoint: savedServer });
source = createClient(Board, { clientId: "source", checkpoint: savedClient,
  onBatch: (batch) => restoredOutgoing.push(batch) });
assert.deepEqual(source.checkpoint(), savedClient);
assert.deepEqual(visible(source), beforeRestore);
assert.equal(restoredOutgoing.length, 0);
assert.equal(submit(source.checkpoint().pendingBatches[0]).serverSeq, 2);
assert.deepEqual(source.checkpoint().pendingBatches, []);
assert.deepEqual(visible(source), visible(peer));

source.transact(() => {
  source.state.count.value = 3;
  source.state.items.push("restored");
  source.state.body.insert(source.state.body.length, "C");
});
assert.equal(restoredOutgoing.length, 1);
assert.equal(restoredOutgoing[0].seq, 3);
for (const path of ["items", "body"]) {
  assert.ok(source.checkpoint().lastBunchSeqs[path] > savedClient.lastBunchSeqs[path]);
}
assert.equal(submit(restoredOutgoing[0]).serverSeq, 3);
assert.deepEqual(visible(source), { count: 3, items: ["first", "pending", "restored"], body: "A😀BC" });
for (const doc of [source, peer]) {
  assert.deepEqual(visible(doc), visible(source));
  assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
  assert.deepEqual(doc.checkpoint().pendingBatches, []);
  assert.equal(doc.replayConflict, null);
}
`;

const typesFixture = `
import {
  createClient, createServer, defineDocument, list, text, value,
  decodeClientBatch, decodeServerCommit, decodeClientCheckpoint, decodeServerCheckpoint, decodeSnapshot,
  type Value, type List, type Text, type DocumentOperation, type DocumentSnapshot,
  type ListSnapshotData, type TextSnapshotData, type ClientCheckpoint, type ServerCheckpoint,
} from "articollab";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
const Board = defineDocument({ count: value(0), items: list<string>(), body: text() });
type Shape = typeof Board.definition;
type Operation = DocumentOperation<Shape>;
const doc = createClient(Board, { clientId: "types", onBatch(batch) {
  type BatchOperation = Expect<Equal<(typeof batch.operations)[number], Operation>>;
} });
const server = createServer(Board);
const snapshot = server.snapshot();
const checkpoint = doc.checkpoint();

type StatePaths = Expect<Equal<keyof typeof doc.state, "count" | "items" | "body">>;
type Count = Expect<Equal<typeof doc.state.count, Value<number>>>;
type Items = Expect<Equal<typeof doc.state.items, List<string>>>;
type Body = Expect<Equal<typeof doc.state.body, Text>>;
type Item = Expect<Equal<ReturnType<typeof doc.state.items.get>, string>>;
type CodePoints = Expect<Equal<ReturnType<typeof doc.state.body.values>, IterableIterator<string>>>;
type ValuePath = Expect<Equal<Extract<Operation, { type: "value/set" }>['path'], "count">>;
type ValuePayload = Expect<Equal<Extract<Operation, { type: "value/set" }>['value'], number>>;
type ListPath = Expect<Equal<Extract<Operation, { type: "list/insert" }>['path'], "items">>;
type ListPayload = Expect<Equal<Extract<Operation, { type: "list/insert" }>['value'], string>>;
type TextPath = Expect<Equal<Extract<Operation, { type: "text/insert" }>['path'], "body">>;
type TextPayload = Expect<Equal<Extract<Operation, { type: "text/insert" }>['value'], string>>;
type Snapshot = Expect<Equal<typeof snapshot, DocumentSnapshot<Shape>>>;
type SnapshotData = Expect<Equal<typeof snapshot.data, Readonly<{
  count: number; items: ListSnapshotData<string>; body: TextSnapshotData;
}>>>;
type ClientSave = Expect<Equal<typeof checkpoint, ClientCheckpoint<Shape>>>;
type ServerSave = Expect<Equal<ReturnType<typeof server.checkpoint>, ServerCheckpoint<Shape>>>;
type BunchCounters = Expect<Equal<typeof checkpoint.lastBunchSeqs, Readonly<{ items: number; body: number }>>>;

doc.state.count.value = 1;
doc.state.items.push("valid");
doc.state.body.insert(0, "😀");
const batch = decodeClientBatch(Board, {});
type DecodedOperation = Expect<Equal<(typeof batch.operations)[number], Operation>>;
doc.receive(decodeServerCommit(Board, {}));
createClient(Board, { clientId: "types", snapshot: decodeSnapshot(Board, {}), onBatch() {} });
createClient(Board, { clientId: "types", checkpoint: decodeClientCheckpoint(Board, {}), onBatch() {} });
createServer(Board, { checkpoint: decodeServerCheckpoint(Board, {}), resolve: ({ batch }) => batch.operations });

// @ts-expect-error Value remains number, not any or a string union.
doc.state.count.value = "wrong";
// @ts-expect-error List elements remain string.
doc.state.items.push(123);
// @ts-expect-error Text insertion requires a string.
doc.state.body.insert(0, 123);
// @ts-expect-error The schema has no missing path.
doc.state.missing;
// @ts-expect-error Operations cannot name paths absent from the schema.
const unknownPath: Operation = { type: "value/set", path: "missing", value: 1 };
// @ts-expect-error A Value operation cannot target a List path.
const wrongKind: Operation = { type: "value/set", path: "items", value: 1 };
// @ts-expect-error A List insertion cannot use a numeric payload.
const wrongPayload: Operation = { type: "list/insert", path: "items", before: null, id: { bunchId: "id", counter: 0 }, value: 1 };
// @ts-expect-error Value snapshot payloads retain their schema type.
const wrongValueSnapshot: DocumentSnapshot<Shape> = { ...snapshot, data: { ...snapshot.data, count: "wrong" } };
// @ts-expect-error List snapshot values retain their element type.
const wrongListSnapshot: DocumentSnapshot<Shape> = { ...snapshot, data: { ...snapshot.data, items: { idList: [], values: [1] } } };
// @ts-expect-error Text snapshot payloads are strings.
const wrongTextSnapshot: DocumentSnapshot<Shape> = { ...snapshot, data: { ...snapshot.data, body: { idList: [], value: 1 } } };
// @ts-expect-error Value paths have no List/Text allocation counter.
checkpoint.lastBunchSeqs.count;
`;

describe("installed package consumer", { timeout: 180_000 }, () => {
  let consumer: string;
  let packed: { filename: string; files: { path: string }[] };

  after(async () => {
    if (consumer) await rm(consumer, { recursive: true, force: true });
  });

  before(async () => {
    consumer = await mkdtemp(join(tmpdir(), "articollab-consumer-"));
    const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
    await run(process.execPath, [compiler, "-p", "tsconfig.build.json"], root);
    const result = await pnpm(["pack", "--json", "--pack-destination", consumer], root);
    const pack = record(JSON.parse(result.stdout));
    assert.ok(typeof pack.filename === "string" && Array.isArray(pack.files));
    packed = { filename: pack.filename, files: pack.files.map((entry: unknown) => {
      const file = record(entry);
      assert.ok(typeof file.path === "string");
      return { path: file.path };
    }) };
    const typescript = await json(require.resolve("typescript/package.json"));
    const nodeTypes = await json(require.resolve("@types/node/package.json"));
    assert.ok(typeof typescript.version === "string" && typeof nodeTypes.version === "string");
    await writeFile(join(consumer, "package.json"), JSON.stringify({
      name: "articollab-package-consumer", private: true, type: "module", packageManager: "pnpm@10.34.5",
      dependencies: { articollab: `file:./${basename(packed.filename)}` },
      devDependencies: { typescript: typescript.version, "@types/node": nodeTypes.version },
    }));
    await pnpm(["install", "--ignore-scripts", "--ignore-workspace", "--no-frozen-lockfile"], consumer, 90_000);
  });

  it("packs only production files and imports the installed ESM entrypoint", async () => {
    const paths = packed.files.map(({ path }) => path);
    for (const required of ["package.json", "README.md", "LICENSE"]) assert.ok(paths.includes(required), required);
    for (const path of paths) {
      assert.ok(["package.json", "README.md", "LICENSE"].includes(path) ||
        /^dist\/.*\.(js|js\.map|d\.ts|d\.ts\.map)$/.test(path), path);
      assert.doesNotMatch(path, /(^|\/)(src|test|tests|examples|node_modules)\//);
    }
    const original = await json(join(root, "package.json"));
    const installedRoot = join(consumer, "node_modules/articollab");
    const installed = await json(join(installedRoot, "package.json"));
    assert.equal(installed.name, "articollab");
    assert.equal(installed.version, "0.1.0-beta.0");
    assert.equal(installed.private, false);
    assert.deepEqual(installed.repository, {
      type: "git", url: "git+https://github.com/EastSun5566/articollab.git",
    });
    assert.deepEqual(installed.publishConfig, {
      registry: "https://registry.npmjs.org/", access: "public", tag: "beta",
    });
    assert.deepEqual(installed.dependencies, { articulated: "^1.3.1" });
    assert.deepEqual(installed.exports, original.exports);
    const entry = record(record(installed.exports)["."]);
    for (const path of [entry.import, entry.types]) {
      assert.ok(typeof path === "string");
      assert.ok(paths.includes(path.replace(/^\.\//, "")), path);
      await readFile(join(installedRoot, path));
    }
    const result = await run(process.execPath, ["--input-type=module", "-e",
      'await import("articollab"); console.log(import.meta.resolve("articollab"));'], consumer);
    const resolved = await realpath(fileURLToPath(result.stdout.trim()));
    assert.equal(resolved, await realpath(join(installedRoot, "dist/index.js")));
    const location = relative(await realpath(consumer), resolved);
    assert.ok(!location.startsWith(`..${sep}`) && location !== "..", resolved);
    assert.equal(result.stderr, "");
  });

  it("synchronizes mixed edits and restores JSON checkpoints through the installed runtime", async () => {
    await writeFile(join(consumer, "runtime.mjs"), runtimeFixture);
    const result = await run(process.execPath, ["--unhandled-rejections=strict", "runtime.mjs"], consumer);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("preserves public schema types and rejects invalid inputs through installed declarations", async () => {
    await writeFile(join(consumer, "types.ts"), typesFixture);
    await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext",
        strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true, types: ["node"], noEmit: true, skipLibCheck: false },
      files: ["types.ts"],
    }));
    const result = await run(process.execPath,
      [join(consumer, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], consumer);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});
