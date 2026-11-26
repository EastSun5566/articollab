import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import {
  createClient, createServer, decodeServerLogEntry, decodeSnapshot, defineDocument, list, value, type ClientBatch, type DocumentOperation,
} from "../src/index.ts";
import {
  CheckpointLockedError, connectSync, createHttpTransport, createSyncHandler, openServer, persistServer,
  type ServerStore, type SyncClient,
} from "../src/sync/index.ts";
import { openFileServerStore } from "../src/sync/node.ts";

const Board = defineDocument({ items: list<string>(), count: value(0) });
type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;

const clone = (input: unknown): unknown => JSON.parse(JSON.stringify(input));

/** A store that keeps parsed JSON in `saved`, which outlives the store like a file or a database. */
function memoryStore(saved: { checkpoint?: unknown; entries: unknown[] } = { entries: [] }) {
  const calls: string[] = [];
  const state = { closed: false, fail: undefined as Error | undefined, hold: undefined as Promise<void> | undefined };
  const store: ServerStore = {
    load: () => Promise.resolve(saved.checkpoint === undefined ? undefined : { checkpoint: clone(saved.checkpoint), entries: saved.entries.map(clone) }),
    async append(entries) {
      calls.push(`append ${entries.length}`);
      await state.hold;
      if (state.fail !== undefined) throw state.fail;
      saved.entries.push(...entries.map(clone));
    },
    compact(checkpoint) {
      calls.push("compact");
      saved.checkpoint = clone(checkpoint);
      saved.entries = [];
      return Promise.resolve();
    },
    close() { state.closed = true; },
  };
  return { store, saved, calls, state };
}

const set = (clientId: string, seq: number, count = seq): Batch =>
  ({ clientId, seq, operations: [{ type: "value/set", path: "count", value: count }] });

describe("Server persistence", () => {
  it("starts an empty store with a checkpoint, appends each flush and compacts every compactEvery entries", async () => {
    const memory = memoryStore();
    const opened = await openServer(Board, memory.store, { compactEvery: 4 });
    assert.deepEqual(memory.calls, ["compact"]);
    const { server } = opened;
    const a = server.openClient();
    await opened.flush();
    server.receive(set(a, 1));
    server.receive(set(a, 2));
    await opened.flush();
    assert.deepEqual(memory.calls, ["compact", "append 1", "append 2"]);
    assert.equal(memory.saved.entries.length, 3);
    server.receive(set(a, 3));
    await opened.flush();
    assert.deepEqual(memory.calls.slice(3), ["append 1", "compact"]);
    assert.equal(memory.saved.entries.length, 0);
    await opened.flush(); // Nothing new.
    assert.equal(memory.calls.length, 5);
    server.receive(set(a, 4, 9));
    await opened.close();
    assert.ok(memory.state.closed);
    await assert.rejects(opened.flush(), /closed/);

    const reopened = await openServer(Board, memoryStore(memory.saved).store);
    assert.deepEqual(reopened.server.checkpoint(), server.checkpoint());
    assert.equal(reopened.server.snapshot().data.count, 9);
  });

  it("restores from many entries and compacts at the next flush", async () => {
    const memory = memoryStore();
    const opened = await openServer(Board, memory.store, { compactEvery: 1000 });
    const a = opened.server.openClient();
    for (let seq = 1; seq <= 5; seq++) opened.server.receive(set(a, seq));
    await opened.close();
    const reopened = await openServer(Board, memoryStore(memory.saved).store, { compactEvery: 3 });
    assert.equal(reopened.server.snapshot().data.count, 5);
    reopened.server.receive(set(a, 6));
    await reopened.flush();
    assert.equal(memory.saved.entries.length, 0, "six saved entries already passed compactEvery");
  });

  it("waits to compact until nothing is pending, so the checkpoint holds exactly the appended entries", async () => {
    const memory = memoryStore();
    const opened = await openServer(Board, memory.store, { compactEvery: 2 });
    const { server } = opened;
    const a = server.openClient();
    server.receive(set(a, 1));
    let release = () => {};
    memory.state.hold = new Promise((resolve) => { release = resolve; });
    const first = opened.flush();
    await Promise.resolve();
    server.receive(set(a, 2)); // Recorded while the append is in flight.
    release();
    await first;
    assert.deepEqual(memory.calls, ["compact", "append 2"], "no compaction with an entry pending");
    memory.state.hold = undefined;
    await opened.flush();
    assert.deepEqual(memory.calls.slice(2), ["append 1", "compact"]);
    const reopened = await openServer(Board, memoryStore(memory.saved).store);
    assert.deepEqual(reopened.server.checkpoint(), server.checkpoint());
  });

  it("fails every later flush after a failed write, and still closes the store", async () => {
    const memory = memoryStore();
    const opened = await openServer(Board, memory.store);
    opened.server.openClient();
    const failure = new Error("disk full");
    memory.state.fail = failure;
    await assert.rejects(opened.flush(), (error) => error === failure);
    memory.state.fail = undefined;
    await assert.rejects(opened.flush(), (error) => error === failure);
    await assert.rejects(opened.close(), (error) => error === failure);
    assert.ok(memory.state.closed);
  });

  it("persists a server it did not open, and checks compactEvery", async () => {
    const server = createServer(Board);
    const memory = memoryStore();
    await memory.store.compact(server.checkpoint());
    const persistence = persistServer(server, memory.store, { compactEvery: 1 });
    server.openClient();
    await persistence.flush();
    assert.deepEqual(memory.calls, ["compact", "append 1", "compact"]);
    assert.throws(() => persistServer(server, memory.store, { compactEvery: 0 }), RangeError);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A wrong type on purpose.
    await assert.rejects(openServer(Board, memoryStore().store, { compactEvery: "1" as unknown as number }), TypeError);
  });

  it("refuses a store whose entries do not follow its checkpoint, leaving the store open", async () => {
    const memory = memoryStore();
    const opened = await openServer(Board, memory.store);
    opened.server.openClient();
    await opened.close();
    const broken = memoryStore({ checkpoint: memory.saved.checkpoint, entries: [{ type: "open", clientId: "client-3" }] });
    await assert.rejects(openServer(Board, broken.store), /out of order/);
    assert.equal(broken.state.closed, false);
  });
});

describe("createSyncHandler with persist", () => {
  /** A handler over a server opened from `memory`, reachable through `fetch`. */
  async function host(memory: ReturnType<typeof memoryStore>) {
    const opened = await openServer(Board, memory.store, { compactEvery: 5 });
    const handle = createSyncHandler(Board, opened.server, { persist: opened });
    return { opened, handle };
  }

  it("saves every change, so a restarted server lets writers carry on and replays a lost response", async () => {
    const saved = { entries: [] as unknown[] };
    let current = await host(memoryStore(saved));
    const fetch = (input: RequestInfo | URL, init?: RequestInit) => current.handle(new Request(input, init));
    const writers: SyncClient<Shape>[] = [];
    for (let index = 0; index < 2; index++) {
      writers.push(await connectSync(Board, { transport: createHttpTransport({ url: "http://sync.test/", fetch }), push: false, pollInterval: 0 }));
    }
    const a = writers[0]!, b = writers[1]!;
    for (let index = 0; index < 4; index++) a.doc.state.items.push(`a${index}`);
    b.doc.state.count.value = 7;
    assert.equal(await a.sync(), true);
    assert.equal(await b.sync(), true);

    // A third writer's batch whose response is lost: the server saved it before answering.
    const post = (route: string, body: unknown) =>
      fetch("http://sync.test/" + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const registered: unknown = await (await post("clients", {})).json();
    assert.ok(typeof registered === "object" && registered !== null && "clientId" in registered && "snapshot" in registered &&
      typeof registered.clientId === "string");
    const lost = createClient(Board, { clientId: registered.clientId, snapshot: decodeSnapshot(Board, registered.snapshot), onBatch() {} });
    lost.state.items.push("lost");
    const batch = lost.checkpoint().pendingBatches[0]!;
    assert.equal((await post("batches", batch)).status, 204);
    const before = current.opened.server.checkpoint();

    // The process stops without closing anything; a new one opens the same storage.
    current = await host(memoryStore(saved));
    assert.deepEqual(current.opened.server.checkpoint(), before);
    assert.equal((await post("batches", batch)).status, 204);
    assert.equal(current.opened.server.snapshot().serverSeq, before.snapshot.serverSeq, "the retry was replayed, not applied again");

    b.doc.state.items.push("b");
    assert.equal(await b.sync(), true);
    assert.equal(await a.sync(), true);
    assert.deepEqual(a.doc.state.items.toArray(), b.doc.state.items.toArray());
    assert.deepEqual(a.doc.state.items.toArray().toSorted(), ["a0", "a1", "a2", "a3", "b", "lost"]);
    for (const writer of writers) writer.close();
  });

  it("saves changes made outside the handler in notify(), and refuses persist with saveCheckpoint", async () => {
    const memory = memoryStore();
    const { opened, handle } = await host(memory);
    const a = opened.server.openClient();
    opened.server.receive(set(a, 1));
    opened.server.closeClient(a);
    assert.equal(memory.saved.entries.length, 0);
    await handle.notify();
    assert.deepEqual(memory.saved.entries.map((entry) => decodeServerLogEntry(Board, entry).type), ["open", "batch", "close"]);
    assert.throws(() => createSyncHandler(Board, opened.server, { persist: opened, saveCheckpoint() {} }), TypeError);
  });

  it("answers 503 after a failed save, like saveCheckpoint", async () => {
    const memory = memoryStore();
    const { handle } = await host(memory);
    memory.state.fail = new Error("disk full");
    const response = await handle(new Request("http://sync.test/clients", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    assert.equal(response.status, 500);
    memory.state.fail = undefined;
    assert.equal((await handle(new Request("http://sync.test/commits?since=0"))).status, 503);
  });
});

/** Opens the same storage again and again, as separate processes would one after another. */
type StoreFactory = (t: TestContext) => Promise<() => Promise<ServerStore>>;

/** What every ServerStore must do, run against each implementation. */
function storeContract(name: string, factory: StoreFactory) {
  describe(`${name} server store`, () => {
    it("keeps the checkpoint and the entries after it, in order, until the next compaction", async (t) => {
      const open = await factory(t);
      let store = await open();
      assert.equal(await store.load(), undefined);
      await store.compact({ checkpoint: 1 });
      await store.append([{ entry: 1 }, { entry: 2, text: "😀\n\u2028" }]);
      await store.append([]);
      await store.append([{ entry: 3 }]);
      store.close();
      store = await open();
      assert.deepEqual(await store.load(), { checkpoint: { checkpoint: 1 }, entries: [{ entry: 1 }, { entry: 2, text: "😀\n\u2028" }, { entry: 3 }] });
      await store.compact({ checkpoint: 2 });
      assert.deepEqual(await store.load(), { checkpoint: { checkpoint: 2 }, entries: [] });
      await store.append([{ entry: 4 }]);
      store.close();
      store = await open();
      assert.deepEqual(await store.load(), { checkpoint: { checkpoint: 2 }, entries: [{ entry: 4 }] });
      store.close();
      await assert.rejects(store.load(), /closed/);
      await assert.rejects(store.append([{ entry: 5 }]), /closed/);
    });

    it("lets one store at a time open the same storage", async (t) => {
      const open = await factory(t);
      const first = await open();
      await assert.rejects(open(), CheckpointLockedError);
      first.close();
      const second = await open();
      assert.equal(await second.load(), undefined);
      second.close();
    });

    it("restores a server that writers used through the handler", async (t) => {
      const open = await factory(t);
      const opened = await openServer(Board, await open(), { compactEvery: 3 });
      const handle = createSyncHandler(Board, opened.server, { persist: opened });
      const fetch = (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init));
      const writer = await connectSync(Board, { transport: createHttpTransport({ url: "http://sync.test/", fetch }), push: false, pollInterval: 0 });
      for (let index = 0; index < 8; index++) {
        writer.doc.state.items.push(`item ${index}`);
        assert.equal(await writer.sync(), true);
      }
      writer.doc.state.count.value = 3;
      assert.equal(await writer.sync(), true);
      writer.close();
      const expected = opened.server.checkpoint();
      await opened.close();
      const reopened = await openServer(Board, await open());
      assert.deepEqual(reopened.server.checkpoint(), expected);
      await reopened.close();
    });
  });
}

storeContract("File", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "articollab-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return () => openFileServerStore(join(directory, "board"));
});

describe("File server store recovery", () => {
  async function directory(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "articollab-server-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return join(root, "board");
  }

  it("drops a line cut short by a crash, and appends after the complete ones", async (t) => {
    const path = await directory(t);
    let store = await openFileServerStore(path);
    await store.compact({ checkpoint: 1 });
    await store.append([{ entry: 1 }]);
    store.close();
    await appendFile(join(path, "log-1.jsonl"), '{"entry":');
    store = await openFileServerStore(path);
    assert.deepEqual(await store.load(), { checkpoint: { checkpoint: 1 }, entries: [{ entry: 1 }] });
    await store.append([{ entry: 2 }]);
    store.close();
    assert.equal(await readFile(join(path, "log-1.jsonl"), "utf8"), '{"entry":1}\n{"entry":2}\n');
  });

  it("recovers from a compaction interrupted at any step", async (t) => {
    const path = await directory(t);
    let store = await openFileServerStore(path);
    await store.compact({ checkpoint: 1 });
    await store.append([{ entry: 1 }]);
    store.close();
    // Interrupted while writing the next checkpoint: only a temporary file exists.
    await writeFile(join(path, ".checkpoint-2.json.crash.tmp"), '{"checkp');
    store = await openFileServerStore(path);
    assert.deepEqual(await store.load(), { checkpoint: { checkpoint: 1 }, entries: [{ entry: 1 }] });
    store.close();
    // Interrupted after the rename: the new checkpoint has no log yet, and the old files remain.
    await writeFile(join(path, "checkpoint-2.json"), '{"checkpoint":2}');
    store = await openFileServerStore(path);
    assert.deepEqual(await store.load(), { checkpoint: { checkpoint: 2 }, entries: [] });
    await store.append([{ entry: 2 }]);
    store.close();
    assert.deepEqual((await readdir(path)).toSorted(), ["checkpoint-2.json", "log-2.jsonl"]);
  });

  it("refuses a store without a checkpoint and a log line that is not JSON", async (t) => {
    const path = await directory(t);
    let store = await openFileServerStore(path);
    await assert.rejects(store.append([{ entry: 1 }]), /no checkpoint yet/);
    await store.compact({ checkpoint: 1 });
    store.close();
    await writeFile(join(path, "log-1.jsonl"), "{}\nnot json\n");
    store = await openFileServerStore(path);
    await assert.rejects(store.load(), /Log line 2 is not valid JSON/);
    store.close();
    await assert.rejects(openFileServerStore(""), TypeError);
  });
});
