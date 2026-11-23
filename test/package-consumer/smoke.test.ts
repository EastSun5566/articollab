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
  createClient, createServer, createUndoManager, defineDocument, list, map, text, value, PayloadValidationError,
  decodeClientBatch, decodeServerCommit, decodeClientCheckpoint, decodeServerCheckpoint, decodeCursor, counter, counterMap,
  CollectionConflictError,
} from "articollab";
import { CheckpointLockedError, connectSync, createHttpTransport, createSyncHandler, openIndexedDbStore } from "articollab/sync";
import { openFileStore, CheckpointLockedError as NodeLockedError } from "articollab/sync/node";

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
    else if (change.type === "move") peerItems = peerItems.toSpliced(change.from, 1).toSpliced(change.to, 0, change.value);
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

const transformServer = createServer(Board, { resolve: ({ batch }) => batch.operations.filter((operation) => operation.type !== "list/insert") });
const transformed = [];
const transformWriter = createClient(Board, { clientId: transformServer.openClient(), onBatch() {} });
transformWriter.on("transform", (event) => transformed.push([event.dropped.map((operation) => operation.value), event.added.length]));
transformWriter.state.items.push("dropped");
transformWriter.receive(decodeServerCommit(Board, roundTrip(transformServer.receive(transformWriter.checkpoint().pendingBatches[0]).commit)));
assert.deepEqual(transformed, [[["dropped"], 0]]);

const undoWriter = createClient(Board, { clientId: createServer(Board).openClient(), onBatch() {} });
const history = createUndoManager(undoWriter, { captureTimeout: 0 });
undoWriter.state.items.push("a");
undoWriter.state.items.delete(0);
assert.equal(history.undo(), true);
assert.deepEqual(undoWriter.state.items.toArray(), ["a"]);
assert.deepEqual([history.undo(), undoWriter.state.items.toArray(), history.canUndo, history.canRedo], [true, [], false, true]);
assert.throws(() => createUndoManager(undoWriter), /already has an undo manager/);
history.destroy();
const grouped = createUndoManager(undoWriter, { captureTimeout: 0, maxSteps: 2 });
const endGroup = grouped.startGroup();
undoWriter.state.items.push("g1");
undoWriter.state.items.push("g2");
endGroup();
assert.equal(grouped.ignore(() => { undoWriter.state.items.push("ignored"); return "kept"; }), "kept");
assert.equal(grouped.undo(), true);
assert.deepEqual([undoWriter.state.items.toArray(), grouped.canUndo], [["ignored"], false]);
grouped.destroy();

const shortTag = { "~standard": { version: 1, vendor: "smoke", validate: (input) =>
  typeof input === "string" && input.length <= 3 ? { value: input } : { issues: [{ message: "Too long" }] } } };
const Tagged = defineDocument({ tags: map(shortTag) });
const taggedServer = createServer(Tagged);
const tagged = createClient(Tagged, { clientId: taggedServer.openClient(), onBatch() {} });
assert.throws(() => tagged.state.tags.set("k", "long"), (error) => error instanceof PayloadValidationError &&
  error.message === "Invalid payload at /tags/k: Too long");
const looseTags = createClient(defineDocument({ tags: map() }), { clientId: taggedServer.openClient(), onBatch() {} });
looseTags.state.tags.set("k", "long");
assert.throws(() => taggedServer.receive(decodeClientBatch(Tagged, roundTrip(looseTags.checkpoint().pendingBatches[0]))), PayloadValidationError);

const trackServer = createServer(Board, { resolve: ({ batch }) => batch.operations.filter((operation) => operation.type !== "list/insert") });
const trackWriter = createClient(Board, { clientId: trackServer.openClient(), onBatch() {} });
const tracked = trackWriter.track(() => { trackWriter.state.items.push("dropped"); return 7; });
assert.equal(tracked.value, 7);
assert.strictEqual(trackWriter.settled(tracked.batch), tracked.settled);
trackWriter.receive(decodeServerCommit(Board, roundTrip(trackServer.receive(tracked.batch).commit)));
const trackedOutcome = await tracked.settled;
assert.deepEqual([trackedOutcome.status, trackedOutcome.dropped.map((operation) => operation.value)], ["rejected", ["dropped"]]);

const presenceServer = createServer(Board);
const presenceHandle = createSyncHandler(Board, presenceServer, { presence: { ttl: 5000 } });
const viaPresence = async (input, init) => presenceHandle(new Request(input, init));
const present = [];
for (let index = 0; index < 2; index++) {
  const sync = await connectSync(Board, { pollInterval: 0, presence: {},
    transport: createHttpTransport({ url: "http://presence.local/api/", fetch: viaPresence }) });
  await sync.sync();
  present.push(sync);
}
present[0].presence.set({ name: "first" });
for (let tries = 0; present[1].presence.peers.size === 0; tries++) {
  assert.ok(tries < 500, "presence did not arrive");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.deepEqual([...present[1].presence.peers.values()], [{ name: "first" }]);
for (const sync of present) sync.close();

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
// syncA's push channel opened after its first pass; B's next commit arrives without polling.
for (let tries = 0; syncA.push !== "open"; tries++) {
  assert.ok(tries < 500, "push channel did not open");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
syncB.doc.state.items.push("pushed");
assert.equal(await syncB.sync(), true);
for (let tries = 0; syncA.doc.state.items.length < 2; tries++) {
  assert.ok(tries < 500, "pushed commit did not arrive");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.deepEqual(syncA.doc.state.items.toArray(), ["synced", "pushed"]);
syncA.close(); syncB.close();

assert.equal(NodeLockedError, CheckpointLockedError, "both entrypoints share one error class");
assert.equal(typeof openIndexedDbStore, "function");
const fileStore = await openFileStore("checkpoint.json");
await assert.rejects(openFileStore("checkpoint.json"), CheckpointLockedError);
const stored = await connectSync(Board, { transport: createHttpTransport({ url: "http://sync.local/api/", fetch: viaHandler }), pollInterval: 0, push: false, store: fileStore });
stored.doc.state.items.push("persisted");
await stored.sync();
stored.close();
const reopened = await openFileStore("checkpoint.json");
const resumed = await connectSync(Board, { transport: createHttpTransport({ url: "http://sync.local/api/", fetch: viaHandler }), pollInterval: 0, push: false, store: reopened });
assert.equal(resumed.doc.checkpoint().clientId, stored.doc.checkpoint().clientId, "the same writer resumes");
assert.equal(resumed.doc.state.items.toArray().at(-1), "persisted");
resumed.close();

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

const moveServer = createServer(Board);
const moveBatches = [];
const mover = createClient(Board, { clientId: moveServer.openClient(), onBatch: (batch) => moveBatches.push(batch) });
const watcher = createClient(Board, { clientId: moveServer.openClient(), onBatch() {} });
mover.transact(() => { for (const item of ["a", "b", "c"]) mover.state.items.push(item); });
mover.state.items.move(0, 2);
const watched = [];
watcher.state.items.observe((event) => watched.push(...event.changes.map((change) => change.type)));
for (const batch of moveBatches) {
  watcher.receive(decodeServerCommit(Board, roundTrip(moveServer.receive(decodeClientBatch(Board, roundTrip(batch))).commit)));
}
assert.deepEqual(watcher.state.items.toArray(), ["b", "c", "a"]);
assert.deepEqual(watched, ["splice", "move"]);
assert.equal(roundTrip(moveServer.snapshot()).data.items.moves.length, 1);

const MapBoard = defineDocument({ fields: map() });
const mapServer = createServer(MapBoard);
const mapBatches = [];
const mapWriter = createClient(MapBoard, { clientId: mapServer.openClient(), onBatch: (batch) => mapBatches.push(batch) });
const mapReader = createClient(MapBoard, { clientId: mapServer.openClient(), onBatch() {} });
const mapChanges = [];
mapReader.state.fields.observe((event) => mapChanges.push(...event.changes));
mapWriter.state.fields.set("b", 2);
mapWriter.state.fields.set("a", 1);
assert.equal(mapWriter.state.fields.delete("a"), true);
for (const batch of mapBatches) {
  mapReader.receive(decodeServerCommit(MapBoard, roundTrip(mapServer.receive(decodeClientBatch(MapBoard, roundTrip(batch))).commit)));
}
assert.deepEqual(mapReader.state.fields.toObject(), { b: 2 });
assert.deepEqual(mapChanges, [{ type: "set", key: "b", value: 2, previous: undefined },
  { type: "set", key: "a", value: 1, previous: undefined }, { type: "delete", key: "a", previous: 1 }]);
assert.deepEqual(roundTrip(mapServer.snapshot().data), { fields: { b: 2 } });

const Tally = defineDocument({ likes: counter(), votes: counterMap() });
const tallyServer = createServer(Tally);
const tallyBatches = [];
const tallyA = createClient(Tally, { clientId: tallyServer.openClient(), onBatch: (batch) => tallyBatches.push(batch) });
const tallyB = createClient(Tally, { clientId: tallyServer.openClient(), onBatch: (batch) => tallyBatches.push(batch) });
tallyA.state.likes.add(1);
tallyB.state.likes.add(1);
tallyA.state.votes.add("card", 2);
tallyB.state.votes.add("card", -2);
for (const batch of tallyBatches.splice(0)) {
  const commit = roundTrip(tallyServer.receive(decodeClientBatch(Tally, roundTrip(batch))).commit);
  for (const doc of [tallyA, tallyB]) doc.receive(decodeServerCommit(Tally, commit));
}
assert.deepEqual([tallyA.state.likes.value, tallyB.state.likes.value, tallyB.state.votes.get("card")], [2, 2, 0]);
assert.deepEqual(roundTrip(tallyServer.snapshot().data), { likes: 2, votes: {} });
// Two writers that each stay in range overflow together: the server throws an exported conflict error.
const big = createClient(Tally, { clientId: tallyServer.openClient(), snapshot: tallyServer.snapshot(), onBatch: (batch) => tallyBatches.push(batch) });
big.state.likes.add(Number.MAX_SAFE_INTEGER - 2); // In range here: 2 + (MAX - 2).
const overflowing = tallyBatches.pop();
tallyA.state.likes.add(1);
tallyServer.receive(decodeClientBatch(Tally, roundTrip(tallyBatches.pop())));
assert.throws(() => tallyServer.receive(decodeClientBatch(Tally, roundTrip(overflowing))),
  (error) => error instanceof CollectionConflictError && error.name === "CollectionConflictError");
`;

const typesFixture = `
import {
  assertClientBatchNamespace,
  createClient, createServer, defineDocument, list, map, text, value,
  decodeClientBatch, decodeServerCommit, decodeClientCheckpoint, decodeServerCheckpoint, decodeSnapshot, decodeCursor,
  type MapChange, type MapChangeEvent, type MapCollection, type MapSetOperation, type MapSnapshotData,
  counter, counterMap, type Counter, type CounterMap, type CounterAddOperation, type CounterMapOperation,
  type CounterMapChangeEvent, type CounterMapSnapshotData,
  type Cursor, type Value, type List, type Text, type TextChange, type TextChangeEvent, type DocumentOperation, type DocumentSnapshot,
  type ListChange, type ListChangeEvent,
  type ListSnapshotData, type ListSetOperation, type ListMoveOperation, type ListMoveEntry, type TextSnapshotData, type ClientCheckpoint, type ServerCheckpoint,
  type CreateServerOptions, type ClientBatch, type ServerCommit, type ServerClientSession, type DiscardEvent, type TransformEvent,
  createUndoManager, type UndoManager, type UndoManagerOptions, type BatchOutcome, type TrackedChange,
  PayloadValidationError, type StandardSchemaV1, type PayloadOf,
} from "articollab";
import {
  connectSync, createSyncHandler, type SyncClient, type SyncHandler, type SyncPushState, type SyncStatus,
  type PresenceSyncClient, type SyncPresence, type SyncPresenceOptions, type SyncHandlerPresenceOptions,
  type SyncSubscription, type SyncTransport, type CheckpointStore, type ConnectSyncOptions, openIndexedDbStore,
  type IndexedDbCheckpointStore,
} from "articollab/sync";
import { openFileStore, type FileStoreOptions } from "articollab/sync/node";
type StoreOption = Expect<Equal<ConnectSyncOptions<Shape>["store"], CheckpointStore | undefined>>;
type OpenedIdb = Expect<Equal<Awaited<ReturnType<typeof openIndexedDbStore>>, IndexedDbCheckpointStore>>;
type IdbSlot = Expect<Equal<Pick<IndexedDbCheckpointStore, "slot" | "key">, { readonly slot: number; readonly key: string }>>;
type IdbIsStore = Expect<IndexedDbCheckpointStore extends CheckpointStore ? true : false>;
type OpenedFile = Expect<Equal<Awaited<ReturnType<typeof openFileStore>>, CheckpointStore>>;
type FileLocks = Expect<Equal<keyof FileStoreOptions, "locks" | "fs">>;
// @ts-expect-error A store needs a database and key.
void openIndexedDbStore({ database: "d" });
// @ts-expect-error Slots are a number.
void openIndexedDbStore({ database: "d", key: "k", slots: "2" });

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
    } else if (change.type === "move") {
      type MovedValue = Expect<Equal<typeof change.value, string>>;
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
  type Discarded = Expect<Equal<(typeof event.operations)[number], ListSetOperation<"items", string> | ListMoveOperation<"items">>>;
  // @ts-expect-error Discarded operations are readonly.
  event.operations.push(event.operations[0]!);
});
// @ts-expect-error Discard listeners receive discard events, not change events.
doc.on("discard", (event: { origin: "local" }) => event);
doc.on("transform", (event) => {
  type Transform = Expect<Equal<typeof event, TransformEvent<Operation>>>;
  type Dropped = Expect<Equal<(typeof event.dropped)[number], Operation>>;
  type Batch = Expect<Equal<typeof event.batch, ClientBatch<Operation>>>;
  // @ts-expect-error Dropped operations are readonly.
  event.dropped.push(event.added[0]!);
});
// @ts-expect-error Transform listeners receive transform events, not change events.
doc.on("transform", (event: { origin: "local" }) => event);
const undoManager: UndoManager = createUndoManager(doc, { captureTimeout: 0, paths: ["items"] } satisfies UndoManagerOptions<Shape>);
// @ts-expect-error Undo paths are the document's keys.
void createUndoManager(doc, { paths: ["itemz"] });
type Undone = Expect<Equal<ReturnType<UndoManager["undo"]>, boolean>>;
// @ts-expect-error canUndo is read-only.
undoManager.canUndo = true;
// @ts-expect-error The only event is "change".
undoManager.on("other", () => {});
const endUndoGroup: () => void = undoManager.startGroup();
endUndoGroup();
const ignoredValue: number = undoManager.ignore(() => 1);
// @ts-expect-error ignore() takes a synchronous callback, like transact().
undoManager.ignore(async () => {});
// @ts-expect-error maxSteps is a number.
createUndoManager(doc, { maxSteps: "10" });
undoManager.destroy();
const columnSchema: StandardSchemaV1<"todo" | "done"> = { "~standard": { version: 1, vendor: "types",
  validate: (input) => input === "todo" || input === "done" ? { value: input } : { issues: [{ message: "No" }] } } };
const Typed = defineDocument({ columns: map(columnSchema), stage: value("todo", columnSchema), order: list(columnSchema) });
type Column = Expect<Equal<PayloadOf<typeof columnSchema>, "todo" | "done">>;
const typedDoc = createClient(Typed, { clientId: "typed", onBatch() {} });
type TypedValue = Expect<Equal<typeof typedDoc.state.stage.value, "todo" | "done">>;
// @ts-expect-error Not a column.
typedDoc.state.columns.set("x", "trash");
// @ts-expect-error The initial value must satisfy the schema's input type.
value("trash", columnSchema);
const undefinedInput: StandardSchemaV1<{ a?: string }> = { "~standard": { version: 1, vendor: "types", validate: (input) => ({ value: input as { a?: string } }) } };
// An optional property is allowed: JSON validation still rejects an explicit undefined at runtime.
type OptionalField = Expect<Equal<PayloadOf<typeof undefinedInput>, { a?: string }>>;
list(undefinedInput);
const dateInput: StandardSchemaV1<Date> = { "~standard": { version: 1, vendor: "types", validate: (input) => ({ value: input as Date }) } };
// @ts-expect-error A schema whose input is not JSON is rejected.
list(dateInput);
const payloadError = new PayloadValidationError(["tags", "k"], [{ message: "Too long" }]);
type PayloadPath = Expect<Equal<typeof payloadError.path, readonly (string | number)[]>>;
const trackedChange = doc.track(() => "value");
type Tracked = Expect<Equal<typeof trackedChange, TrackedChange<string, Operation>>>;
type TrackedStatus = Expect<Equal<NonNullable<Awaited<typeof trackedChange.settled>>["status"], "accepted" | "transformed" | "rejected">>;
type Outcome = Expect<Equal<ReturnType<typeof doc.settled>, Promise<BatchOutcome<Operation>>>>;
// @ts-expect-error track() takes a synchronous callback, like transact().
doc.track(async () => {});
void trackedChange.settled.then((outcome) => {
  // @ts-expect-error Outcome arrays are readonly.
  outcome?.dropped.push(outcome.dropped[0]!);
});
type Connected = Expect<Equal<Awaited<ReturnType<typeof connectSync<Shape>>>, SyncClient<Shape>>>;
declare const presenceSchema: StandardSchemaV1<{ name: string }>;
declare const transportForTypes: SyncTransport;
const withPresence = await connectSync(Board, { transport: transportForTypes, presence: { schema: presenceSchema } });
type WithPresence = Expect<Equal<typeof withPresence, PresenceSyncClient<Shape, { name: string }>>>;
type PresencePeers = Expect<Equal<typeof withPresence.presence.peers, ReadonlyMap<string, { name: string }>>>;
// @ts-expect-error Not the schema's state.
withPresence.presence.set({ nickname: "x" });
const withoutPresence = await connectSync(Board, { transport: transportForTypes });
// @ts-expect-error Presence is only there when enabled.
void withoutPresence.presence;
type PresenceApi = Expect<Equal<SyncPresence<{ name: string }>["state"], { name: string } | null>>;
const handlerPresence: SyncHandlerPresenceOptions = { schema: presenceSchema, ttl: 1000 };
const clientPresence: SyncPresenceOptions<{ name: string }> = { schema: presenceSchema, republishInterval: 1000 };
type Status = Expect<Equal<SyncClient<Shape>["status"], SyncStatus>>;
type Handler = Expect<Equal<ReturnType<typeof createSyncHandler<Shape>>, SyncHandler>>;
const asPlainHandler: (request: Request) => Promise<Response> = createSyncHandler(Board, server);
type Notify = Expect<Equal<ReturnType<SyncHandler["notify"]>, Promise<void>>>;
type PushState = Expect<Equal<SyncClient<Shape>["push"], SyncPushState>>;
type Subscribe = Expect<Equal<Parameters<NonNullable<SyncTransport["subscribe"]>>, [watermark: number, handlers: SyncSubscription]>>;
void asPlainHandler;
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
type ListMoveArgs = Expect<Equal<Parameters<typeof doc.state.items.move>, [from: number, to: number]>>;
type ListMove = Expect<Equal<Extract<Operation, { type: "list/move" }>, ListMoveOperation<"items">>>;
type MoveChange = Expect<Equal<Extract<ListChange<string>, { type: "move" }>, { readonly type: "move"; readonly from: number; readonly to: number; readonly value: string }>>;
type SnapshotMoves = Expect<Equal<ListSnapshotData<string>["moves"], readonly ListMoveEntry[] | undefined>>;
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

const Tally = defineDocument({ likes: counter(3), votes: counterMap() });
type TallyShape = typeof Tally.definition;
declare const tally: import("articollab").ClientDocument<TallyShape>;
type TallyLikes = Expect<Equal<typeof tally.state.likes, Counter>>;
type TallyVotes = Expect<Equal<typeof tally.state.votes, CounterMap>>;
type TallyValue = Expect<Equal<typeof tally.state.likes.value, number>>;
type TallyGet = Expect<Equal<ReturnType<typeof tally.state.votes.get>, number>>;
type TallyOperation = Expect<Equal<DocumentOperation<TallyShape>, CounterAddOperation<"likes"> | CounterMapOperation<"votes">>>;
type TallySnapshot = Expect<Equal<ReturnType<typeof tally.checkpoint>["snapshot"]["data"], Readonly<{ likes: number; votes: CounterMapSnapshotData }>>>;
tally.state.votes.observe((event) => { type Event = Expect<Equal<typeof event, CounterMapChangeEvent>>; });
// @ts-expect-error A counter is added to, not set.
tally.state.likes.value = 1;
// @ts-expect-error Deltas are numbers.
tally.state.votes.add("card", "1");

const Settings = defineDocument({ fields: map<{ title: string }>(), count: value(0) });
type SettingsShape = typeof Settings.definition;
type SettingsOperation = DocumentOperation<SettingsShape>;
declare const settings: import("articollab").ClientDocument<SettingsShape>;
type SettingsFields = Expect<Equal<typeof settings.state.fields, MapCollection<{ title: string }>>>;
type MapGet = Expect<Equal<ReturnType<typeof settings.state.fields.get>, { title: string } | undefined>>;
type MapDelete = Expect<Equal<ReturnType<typeof settings.state.fields.delete>, boolean>>;
type MapEntry = Expect<Equal<ReturnType<typeof settings.state.fields.entries>, IterableIterator<[string, { title: string }]>>>;
type MapSet = Expect<Equal<Extract<SettingsOperation, { type: "map/set" }>, MapSetOperation<"fields", { title: string }>>>;
type MapSnapshot = Expect<Equal<ReturnType<typeof settings.checkpoint>["snapshot"]["data"]["fields"], MapSnapshotData<{ title: string }>>>;
type MapBunchCounters = Expect<Equal<ReturnType<typeof settings.checkpoint>["lastBunchSeqs"], Readonly<{}>>>;
settings.state.fields.observe((event) => {
  type Event = Expect<Equal<typeof event, MapChangeEvent<{ title: string }>>>;
  for (const change of event.changes) {
    type Change = Expect<Equal<typeof change, MapChange<{ title: string }>>>;
    if (change.type === "set") {
      type Previous = Expect<Equal<typeof change.previous, { title: string } | undefined>>;
    } else {
      type Removed = Expect<Equal<typeof change.previous, { title: string }>>;
    }
  }
  // @ts-expect-error Observed Map changes are readonly.
  event.changes.push({ type: "delete", key: "x", previous: { title: "x" } });
});
// @ts-expect-error Map values retain their schema type.
settings.state.fields.set("a", { title: 1 });
// @ts-expect-error Map keys are strings.
settings.state.fields.set(1, { title: "x" });
// @ts-expect-error A Map operation cannot target a Value path.
const wrongMapPath: SettingsOperation = { type: "map/set", path: "count", key: "a", value: { title: "x" } };

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
    assert.deepEqual(installed.dependencies, { articulated: "^1.4.0" });
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
