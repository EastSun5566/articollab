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
  if (cli === undefined || cli === "") return run("pnpm", args, cwd, timeout);
  // pnpm 12 is a native executable; older releases expose a JavaScript entrypoint.
  return /\.[cm]?js$/.test(cli) ? run(process.execPath, [cli, ...args], cwd, timeout) : run(cli, args, cwd, timeout);
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
  assertClientBatchNamespace,
  createClient, createServer, defineDocument, list, text, value,
  decodeClientBatch, decodeServerCommit, decodeClientCheckpoint, decodeServerCheckpoint, decodeCursor,
} from "articollab";
import { connectSync, createHttpTransport, createSyncHandler } from "articollab/sync";

const Board = defineDocument({ count: value(0), items: list(), body: text() });
const roundTrip = (input) => JSON.parse(JSON.stringify(input));
const visible = (doc) => ({ count: doc.state.count.value,
  items: doc.state.items.toArray(), body: doc.state.body.toString() });
let server = createServer(Board);
const outgoing = [];
const sourceId = server.openClient();
let source = createClient(Board, { clientId: sourceId, onBatch: (batch) => outgoing.push(batch) });
const peer = createClient(Board, { clientId: server.openClient(), onBatch() {} });
let peerText = [...peer.state.body];
let textNotifications = 0;
const stopObserving = peer.state.body.observe((event) => {
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.changes));
  assert.equal(event.beforeLength, peerText.length);
  for (const { index, deleteCount, insert } of event.changes) {
    assert.ok(Object.isFrozen(insert));
    peerText = peerText.slice(0, index).concat(insert, peerText.slice(index + deleteCount));
  }
  assert.equal(event.afterLength, peerText.length);
  assert.deepEqual(peerText, [...peer.state.body]);
  textNotifications++;
});
let peerItems = [...peer.state.items];
let listSets = 0, listSplices = 0;
const stopObservingItems = peer.state.items.observe((event) => {
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.changes));
  assert.equal(event.beforeLength, peerItems.length);
  for (const change of event.changes) {
    assert.ok(Object.isFrozen(change));
    if (change.type === "set") { peerItems = peerItems.with(change.index, change.value); listSets++; }
    else { peerItems = peerItems.toSpliced(change.index, change.deleteCount, ...change.insert); listSplices++; }
  }
  assert.equal(event.afterLength, peerItems.length);
  assert.deepEqual(peerItems, peer.state.items.toArray());
});
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
  const decoded = decodeClientBatch(Board, roundTrip(batch));
  assert.equal(assertClientBatchNamespace(decoded, sourceId), undefined);
  assert.throws(() => assertClientBatchNamespace(decoded, "other-writer"), TypeError);
  const receipt = server.receive(decoded);
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
  source.state.items.set(0, "updated");
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
source = createClient(Board, { clientId: sourceId, checkpoint: savedClient,
  onBatch: (batch) => restoredOutgoing.push(batch) });
assert.deepEqual(source.checkpoint(), savedClient);
assert.deepEqual(visible(source), beforeRestore);
assert.equal(restoredOutgoing.length, 0);
assert.equal(submit(source.checkpoint().pendingBatches[0]).serverSeq, 2);
assert.deepEqual(source.checkpoint().pendingBatches, []);
assert.deepEqual(visible(source), visible(peer));

source.transact(() => {
  source.state.count.value = 3;
  source.state.items.set(0, "updated after restore");
  source.state.items.push("restored");
  source.state.body.insert(source.state.body.length, "C");
});
assert.equal(restoredOutgoing.length, 1);
assert.equal(restoredOutgoing[0].seq, 3);
for (const path of ["items", "body"]) {
  assert.ok(source.checkpoint().lastBunchSeqs[path] > savedClient.lastBunchSeqs[path]);
}
assert.equal(submit(restoredOutgoing[0]).serverSeq, 3);
assert.deepEqual(visible(source), { count: 3, items: ["updated after restore", "pending", "restored"], body: "A😀BC" });
for (const doc of [source, peer]) {
  assert.deepEqual(visible(doc), visible(source));
  assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
  assert.deepEqual(doc.checkpoint().pendingBatches, []);
  assert.equal(doc.replayConflict, null);
}
const beforeClose = server.snapshot();
server.closeClient(sourceId);
assert.equal(server.checkpoint().clients.some((entry) => entry.clientId === sourceId), false);
assert.deepEqual(server.snapshot(), beforeClose);
assert.throws(() => server.receive(restoredOutgoing[0]));
assert.notEqual(server.openClient(), sourceId);

const guarded = createServer(Board);
const writerId = guarded.openClient();
const custom = decodeClientBatch(Board, {
  clientId: writerId, seq: 1, operations: [{ type: "list/insert", path: "items",
    before: null, id: { bunchId: "custom", counter: 0 }, value: "custom" }],
});
const beforeGuard = guarded.checkpoint();
assert.throws(() => guarded.receive(custom), TypeError);
assert.deepEqual(guarded.checkpoint(), beforeGuard);
const optedOut = createServer(Board, { allowCustomClientNamespaces: true });
assert.equal(optedOut.openClient(), writerId);
const customResult = optedOut.receive(custom);
assert.deepEqual(optedOut.snapshot().data.items.values, ["custom"]);
const restoredCustom = createServer(Board, {
  checkpoint: decodeServerCheckpoint(Board, roundTrip(optedOut.checkpoint())),
});
assert.deepEqual(restoredCustom.receive(custom), { commit: customResult.commit, replayed: true });
assert.deepEqual(peerText, [...peer.state.body]);
assert.equal(textNotifications, 3);
stopObserving(); stopObserving();
assert.ok(listSets > 0 && listSplices > 0);
stopObservingItems(); stopObservingItems();

const Unicode = defineDocument({ body: text() });
let unicodeServer = createServer(Unicode);
const unicodeId = unicodeServer.openClient();
const unicodeBatches = [];
let unicode = createClient(Unicode, { clientId: unicodeId, onBatch: (batch) => unicodeBatches.push(batch) });
for (const half of ["\\ud83d", "\\ude00"]) {
  unicode.state.body.insert(unicode.state.body.length, half);
  unicode.receive(decodeServerCommit(Unicode, roundTrip(unicodeServer.receive(unicodeBatches.at(-1)).commit)));
}
assert.deepEqual([...unicode.state.body], ["\\ud83d", "\\ude00"]);
assert.deepEqual(unicodeServer.snapshot().data.body.surrogateBoundaries, [1]);
const unicodeSave = decodeClientCheckpoint(Unicode, roundTrip(unicode.checkpoint()));
unicodeServer = createServer(Unicode, { checkpoint: decodeServerCheckpoint(Unicode, roundTrip(unicodeServer.checkpoint())) });
unicode = createClient(Unicode, { clientId: unicodeId, checkpoint: unicodeSave,
  onBatch: (batch) => unicodeBatches.push(batch) });
assert.deepEqual([...unicode.state.body], ["\\ud83d", "\\ude00"]);
assert.deepEqual(unicode.checkpoint(), unicodeSave);
unicode.state.body.delete(0);
unicode.receive(unicodeServer.receive(unicodeBatches.at(-1)).commit);
assert.deepEqual([...unicode.state.body], ["\\ude00"]);
assert.equal(Object.hasOwn(unicodeServer.snapshot().data.body, "surrogateBoundaries"), false);

const discardServer = createServer(Board);
const discardBatches = [];
const writer = createClient(Board, { clientId: discardServer.openClient(), onBatch: (batch) => discardBatches.push(batch) });
const deleter = createClient(Board, { clientId: discardServer.openClient(), onBatch: (batch) => discardBatches.push(batch) });
const deliverAll = () => {
  for (const batch of discardBatches.splice(0)) {
    const commit = decodeServerCommit(Board, roundTrip(discardServer.receive(batch).commit));
    writer.receive(commit); deleter.receive(commit);
  }
};
writer.state.items.push("item");
deliverAll();
const discarded = [];
writer.on("discard", (event) => discarded.push(...event.operations.map((operation) => operation.value)));
deleter.state.items.delete(0);
writer.state.items.set(0, "edited");
deliverAll();
assert.deepEqual(discarded, ["edited"]);

const syncServer = createServer(Board);
const handle = createSyncHandler(Board, syncServer);
const viaHandler = async (input, init) => handle(new Request(input, init));
const syncA = await connectSync(Board, { pollInterval: 0, transport: createHttpTransport({ url: "http://sync.local/api/", fetch: viaHandler }) });
const syncB = await connectSync(Board, { pollInterval: 0, transport: createHttpTransport({ url: "http://sync.local/api/", fetch: viaHandler }) });
syncA.doc.state.items.push("synced");
assert.equal(await syncA.sync(), true);
assert.equal(await syncB.sync(), true);
assert.deepEqual(syncB.doc.state.items.toArray(), ["synced"]);
assert.equal(syncB.status, "idle");
syncA.stop(); syncB.stop();

const sessionServer = createServer(Board);
const sessionId = sessionServer.openClient();
assert.deepEqual(sessionServer.listClients(), [{ clientId: sessionId, lastSeq: 0, lastServerSeq: null }]);
sessionServer.receive({ clientId: sessionId, seq: 1, operations: [{ type: "value/set", path: "count", value: 1 }] });
assert.deepEqual(sessionServer.listClients(), [{ clientId: sessionId, lastSeq: 1, lastServerSeq: 1 }]);

const cursorServer = createServer(Board);
const cursorBatches = [];
const cursorWriter = createClient(Board, { clientId: cursorServer.openClient(), onBatch: (batch) => cursorBatches.push(batch) });
const cursorReader = createClient(Board, { clientId: cursorServer.openClient(), onBatch() {} });
cursorWriter.state.body.insert(0, "abc");
const caret = decodeCursor(roundTrip(cursorWriter.state.body.cursorAt(2)));
assert.ok(Object.isFrozen(caret) && Object.isFrozen(caret.anchor));
assert.equal(cursorReader.state.body.cursorIndex(caret), undefined);
cursorReader.receive(decodeServerCommit(Board, roundTrip(cursorServer.receive(cursorBatches.at(-1)).commit)));
assert.equal(cursorReader.state.body.cursorIndex(caret), 2);
cursorWriter.state.items.push("x");
assert.equal(cursorWriter.state.items.cursorIndex(cursorWriter.state.items.cursorAt(1, "right")), 1);
`;

const typesFixture = `
import {
  assertClientBatchNamespace,
  createClient, createServer, defineDocument, list, text, value,
  decodeClientBatch, decodeServerCommit, decodeClientCheckpoint, decodeServerCheckpoint, decodeSnapshot, decodeCursor,
  type Cursor, type Value, type List, type Text, type TextChange, type TextChangeEvent, type DocumentOperation, type DocumentSnapshot,
  type ListChange, type ListChangeEvent,
  type ListSnapshotData, type ListSetOperation, type TextSnapshotData, type ClientCheckpoint, type ServerCheckpoint,
  type CreateServerOptions, type ClientBatch, type ServerCommit, type ServerClientSession, type DiscardEvent,
} from "articollab";
import { connectSync, createSyncHandler, type SyncClient, type SyncStatus, type SyncTransport } from "articollab/sync";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
const Board = defineDocument({ count: value(0), items: list<string>(), body: text() });
type Shape = typeof Board.definition;
type ClientCapacity = Expect<Equal<CreateServerOptions<Shape>["maxClients"], number | undefined>>;
type Sessions = Expect<Equal<ReturnType<ReturnType<typeof createServer<Shape>>["listClients"]>, readonly ServerClientSession[]>>;
type SessionServerSeq = Expect<Equal<ServerClientSession["lastServerSeq"], number | null>>;
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
type StopObserving = Expect<Equal<ReturnType<typeof doc.state.body.observe>, () => void>>;
doc.state.body.observe((event) => {
  type Event = Expect<Equal<typeof event, TextChangeEvent>>;
  type Changes = Expect<Equal<typeof event.changes, readonly TextChange[]>>;
  type Inserted = Expect<Equal<TextChange["insert"], readonly string[]>>;
  // @ts-expect-error Observed changes are readonly.
  event.changes.push({ index: 0, deleteCount: 0, insert: [] });
  // @ts-expect-error Inserted elements are readonly.
  event.changes[0]!.insert.push("x");
  // @ts-expect-error Length metadata is readonly.
  event.beforeLength = 0;
});
// @ts-expect-error Observers require a callback.
doc.state.body.observe(123);
type StopObservingItems = Expect<Equal<ReturnType<typeof doc.state.items.observe>, () => void>>;
doc.state.items.observe((event) => {
  type Event = Expect<Equal<typeof event, ListChangeEvent<string>>>;
  type Changes = Expect<Equal<typeof event.changes, readonly ListChange<string>[]>>;
  for (const change of event.changes) {
    if (change.type === "set") {
      type SetValue = Expect<Equal<typeof change.value, string>>;
    } else {
      type Inserted = Expect<Equal<typeof change.insert, readonly string[]>>;
      // @ts-expect-error Inserted elements are readonly.
      change.insert.push("x");
    }
  }
  // @ts-expect-error Observed changes are readonly.
  event.changes.push({ type: "set", index: 0, value: "x" });
});
// @ts-expect-error List observers require a callback.
doc.state.items.observe("callback");
doc.on("discard", (event) => {
  type Discard = Expect<Equal<typeof event, DiscardEvent<Operation>>>;
  type Discarded = Expect<Equal<(typeof event.operations)[number], ListSetOperation<"items", string>>>;
  // @ts-expect-error Discarded operations are readonly.
  event.operations.push(event.operations[0]!);
});
// @ts-expect-error Discard listeners receive discard events, not change events.
doc.on("discard", (event: { origin: "local" }) => event);
type Connected = Expect<Equal<Awaited<ReturnType<typeof connectSync<Shape>>>, SyncClient<Shape>>>;
type Status = Expect<Equal<SyncClient<Shape>["status"], SyncStatus>>;
type Handler = Expect<Equal<ReturnType<typeof createSyncHandler<Shape>>, (request: Request) => Promise<Response>>>;
declare const transport: SyncTransport;
// @ts-expect-error pollInterval is a number of milliseconds.
void connectSync(Board, { transport, pollInterval: "fast" });
// @ts-expect-error The handler cannot be given an unknown option.
createSyncHandler(Board, server, { allowRejection: true });
type TextCursor = Expect<Equal<ReturnType<typeof doc.state.body.cursorAt>, Cursor>>;
type ListCursorIndex = Expect<Equal<ReturnType<typeof doc.state.items.cursorIndex>, number | undefined>>;
type DecodedCursor = Expect<Equal<ReturnType<typeof decodeCursor>, Cursor>>;
type CursorBind = Expect<Equal<Cursor["bind"], "left" | "right">>;
const cursor = doc.state.items.cursorAt(0, "right");
const takeIndex = (index: number) => index;
// @ts-expect-error A cursor may not resolve yet.
takeIndex(doc.state.items.cursorIndex(cursor));
const resolved = doc.state.body.cursorIndex(cursor);
if (resolved !== undefined) takeIndex(resolved);
// @ts-expect-error Cursors bind left or right.
doc.state.body.cursorAt(0, "middle");
// @ts-expect-error Cursors are readonly.
cursor.bind = "left";
// @ts-expect-error Cursor anchors are readonly.
if (cursor.anchor !== null) cursor.anchor.counter = 1;
type ValuePath = Expect<Equal<Extract<Operation, { type: "value/set" }>['path'], "count">>;
type ValuePayload = Expect<Equal<Extract<Operation, { type: "value/set" }>['value'], number>>;
type ListPath = Expect<Equal<Extract<Operation, { type: "list/insert" }>['path'], "items">>;
type ListPayload = Expect<Equal<Extract<Operation, { type: "list/insert" }>['value'], string>>;
type ListSet = Expect<Equal<Extract<Operation, { type: "list/set" }>, ListSetOperation<"items", string>>>;
type ListSetArgs = Expect<Equal<Parameters<typeof doc.state.items.set>, [index: number, value: string]>>;
type ListSetResult = Expect<Equal<ReturnType<typeof doc.state.items.set>, void>>;
type TextPath = Expect<Equal<Extract<Operation, { type: "text/insert" }>['path'], "body">>;
type TextPayload = Expect<Equal<Extract<Operation, { type: "text/insert" }>['value'], string>>;
type Snapshot = Expect<Equal<typeof snapshot, DocumentSnapshot<Shape>>>;
type SnapshotData = Expect<Equal<typeof snapshot.data, Readonly<{
  count: number; items: ListSnapshotData<string>; body: TextSnapshotData;
}>>>;
type SurrogateBoundaries = Expect<Equal<TextSnapshotData["surrogateBoundaries"], readonly number[] | undefined>>;
const legacyText: TextSnapshotData = { idList: [], value: "" };
const splitText: TextSnapshotData = { idList: [], value: "😀", surrogateBoundaries: [1] };
// @ts-expect-error Snapshot boundary arrays are readonly.
splitText.surrogateBoundaries!.push(2);
// @ts-expect-error Snapshot boundary metadata is readonly.
splitText.surrogateBoundaries = [2];
// @ts-expect-error Boundary offsets must be numbers.
const wrongBoundary: TextSnapshotData = { idList: [], value: "😀", surrogateBoundaries: ["1"] };
// @ts-expect-error An explicitly supplied optional field cannot be undefined.
const undefinedBoundary: TextSnapshotData = { idList: [], value: "", surrogateBoundaries: undefined };
type ClientSave = Expect<Equal<typeof checkpoint, ClientCheckpoint<Shape>>>;
type ServerSave = Expect<Equal<ReturnType<typeof server.checkpoint>, ServerCheckpoint<Shape>>>;
type ClientId = Expect<Equal<ReturnType<typeof server.openClient>, string>>;
type CloseResult = Expect<Equal<ReturnType<typeof server.closeClient>, void>>;
type AllocationCounter = Expect<Equal<ServerCheckpoint<Shape>["lastClientNumber"], number>>;
type Replay = Expect<Equal<ServerCheckpoint<Shape>["clients"][number]["replay"],
  Readonly<{ batch: ClientBatch<Operation>; commit: ServerCommit<Operation> }> | null>>;
// @ts-expect-error Closing requires an issued string identity.
server.closeClient(123);
// @ts-expect-error Legacy replay-array checkpoints are not accepted.
createServer(Board, { checkpoint: { snapshot, replays: [], history: [] } });
type BunchCounters = Expect<Equal<typeof checkpoint.lastBunchSeqs, Readonly<{ items: number; body: number }>>>;

doc.state.count.value = 1;
doc.state.items.push("valid");
doc.state.items.set(0, "updated");
doc.state.body.insert(0, "😀");
const batch = decodeClientBatch(Board, {});
assertClientBatchNamespace(batch, "types");
type NamespaceResult = Expect<Equal<ReturnType<typeof assertClientBatchNamespace>, void>>;
// @ts-expect-error Writer binding requires a string.
assertClientBatchNamespace(batch, 123);
// @ts-expect-error The guard accepts a typed batch, not arbitrary unknown input.
assertClientBatchNamespace({} as unknown, "types");
type DecodedOperation = Expect<Equal<(typeof batch.operations)[number], Operation>>;
doc.receive(decodeServerCommit(Board, {}));
createClient(Board, { clientId: "types", snapshot: decodeSnapshot(Board, {}), onBatch() {} });
createClient(Board, { clientId: "types", checkpoint: decodeClientCheckpoint(Board, {}), onBatch() {} });
createServer(Board, { checkpoint: decodeServerCheckpoint(Board, {}), resolve: ({ batch }) => batch.operations });
createServer(Board, { maxClients: 2 });
createServer(Board, { allowCustomClientNamespaces: true });
createServer(Board, { allowCustomClientNamespaces: false });
// @ts-expect-error Namespace opt-out requires a boolean.
createServer(Board, { allowCustomClientNamespaces: "true" });
// @ts-expect-error Client capacity requires a number, not a string.
createServer(Board, { maxClients: "2" });

// @ts-expect-error Value remains number, not any or a string union.
doc.state.count.value = "wrong";
// @ts-expect-error List elements remain string.
doc.state.items.push(123);
// @ts-expect-error List set retains the element payload type.
doc.state.items.set(0, 123);
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
// @ts-expect-error List set cannot use a numeric payload.
const wrongSetPayload: Operation = { type: "list/set", path: "items", id: { bunchId: "id", counter: 0 }, value: 1 };
// @ts-expect-error List set cannot target a Text path.
const wrongSetPath: Operation = { type: "list/set", path: "body", id: { bunchId: "id", counter: 0 }, value: "x" };
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
    const { packageManager } = await json(join(root, "package.json"));
    assert.ok(typeof typescript.version === "string" && typeof nodeTypes.version === "string");
    assert.ok(typeof packageManager === "string");
    await writeFile(join(consumer, "package.json"), JSON.stringify({
      name: "articollab-package-consumer", private: true, type: "module", packageManager,
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
    assert.ok(typeof original.version === "string");
    const installedRoot = join(consumer, "node_modules/articollab");
    const installed = await json(join(installedRoot, "package.json"));
    for (const path of ["dist/vendor/hamt.js", "dist/vendor/hamt.d.ts"]) {
      assert.ok(paths.includes(path), path);
    }
    const vendor = await readFile(join(installedRoot, "dist/vendor/hamt.js"), "utf8");
    const source = await readFile(join(root, "src/vendor/hamt.ts"), "utf8");
    const notice = source.match(/^\/\*![\s\S]*?\*\//)?.[0];
    assert.ok(notice !== undefined);
    assert.ok(vendor.includes(notice), "The complete vendor notice must survive packing");
    assert.match(notice, /Copyright \(C\) 2016 Matt Bierner/);
    assert.match(notice, /b8845c7343fdde3966f875d732248fec597cf538/);
    assert.equal(installed.name, "articollab");
    assert.equal(installed.version, original.version);
    assert.equal(installed.private, false);
    assert.deepEqual(installed.repository, {
      type: "git", url: "git+https://github.com/EastSun5566/articollab.git",
    });
    assert.equal(installed.homepage, "https://eastsun5566.github.io/articollab/");
    assert.deepEqual(installed.bugs, {
      url: "https://github.com/EastSun5566/articollab/issues",
    });
    assert.deepEqual(installed.keywords, [
      "collaboration", "realtime", "sync", "local-first", "server-reconciliation",
    ]);
    assert.deepEqual(installed.author, {
      name: "EastSun5566", email: "hi@eastsun.me", url: "https://github.com/EastSun5566",
    });
    assert.deepEqual(installed.publishConfig, {
      registry: "https://registry.npmjs.org/", access: "public", tag: "beta",
    });
    assert.deepEqual(installed.dependencies, { articulated: "^1.3.1" });
    assert.deepEqual(installed.exports, original.exports);
    for (const subpath of [".", "./sync"]) {
      const entry = record(record(installed.exports)[subpath]);
      for (const path of [entry.import, entry.types]) {
        assert.ok(typeof path === "string");
        assert.ok(paths.includes(path.replace(/^\.\//, "")), path);
        await readFile(join(installedRoot, path));
      }
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
