import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { IDBFactory } from "fake-indexeddb";

import { createServer, decodeClientBatch, decodeClientCheckpoint, defineDocument, list, value, type ClientBatch } from "../src/index.ts";
import {
  CheckpointLockedError, connectSync, openIndexedDbStore, type CheckpointStore, type SyncTransport,
} from "../src/sync/index.ts";
import { openFileStore, type FileStoreFileSystem } from "../src/sync/node.ts";

const Board = defineDocument({ items: list<string>(), count: value(0) });
const wire = (input: unknown): unknown => JSON.parse(JSON.stringify(input));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** An in-process server behind a JSON transport; `hold()` makes the next submission wait until released. */
function harness() {
  const server = createServer(Board);
  const submitted: string[] = [];
  let gate: Promise<void> | undefined;
  return {
    server, submitted,
    hold() {
      let release = () => {};
      gate = new Promise<void>((resolve) => { release = resolve; });
      return () => { gate = undefined; release(); };
    },
    transport(): SyncTransport {
      return {
        async register() { return { clientId: server.openClient(), snapshot: wire(server.snapshot()) }; },
        async submit(batch: ClientBatch) {
          submitted.push(`${batch.clientId}:${batch.seq}`);
          if (gate !== undefined) await gate;
          server.receive(decodeClientBatch(Board, wire(batch)));
        },
        async reject(batch: ClientBatch) { server.reject(decodeClientBatch(Board, wire(batch))); },
        async commitsSince(watermark: number) { return wire(server.commitsSince(watermark)); },
      };
    },
  };
}

/** A fresh in-memory IndexedDB and a unique database name per test. */
function idb(t: TestContext) {
  const indexedDB = new IDBFactory();
  const database = `test-${randomUUID()}`;
  const opened: CheckpointStore[] = [];
  t.after(() => { for (const store of opened) store.close(); });
  return {
    async open(key = "writer") {
      const store = await openIndexedDbStore({ database, key, indexedDB });
      opened.push(store);
      return store;
    },
  };
}

async function directory(t: TestContext): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), "articollab-store-"));
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}

describe("IndexedDB checkpoint store", () => {
  it("saves, loads and clears one key's checkpoint as JSON", async (t) => {
    const db = idb(t);
    const store = await db.open("a");
    assert.equal(await store.load(), undefined);
    await store.save({ clientId: "client-1", nested: { values: [1, "two"] } });
    assert.deepEqual(await store.load(), { clientId: "client-1", nested: { values: [1, "two"] } });
    const other = await db.open("b");
    assert.equal(await other.load(), undefined, "keys are independent");
    await store.clear();
    assert.equal(await store.load(), undefined);
    store.close();
    store.close();
    await assert.rejects(store.load(), /closed/);
    await assert.rejects(store.save({}), /closed/);
  });

  it("refuses a second open of the same key until the first is closed", async (t) => {
    const db = idb(t);
    const first = await db.open();
    await first.save({ from: "first" });
    await assert.rejects(db.open(), (error) => error instanceof CheckpointLockedError && error.name === "CheckpointLockedError");
    first.close();
    const second = await db.open();
    assert.deepEqual(await second.load(), { from: "first" }, "the data survives closing");
  });

  it("validates options and the environment", async () => {
    await assert.rejects(openIndexedDbStore({ database: "", key: "k", indexedDB: new IDBFactory() }), TypeError);
    await assert.rejects(openIndexedDbStore({ database: "d", key: "k" }), /indexedDB is unavailable/);
  });
});

describe("File checkpoint store", () => {
  it("saves atomically, loads, clears and leaves no temporary files", async (t) => {
    const dir = await directory(t);
    const path = join(dir, "writer.json");
    const store = await openFileStore(path);
    t.after(() => store.close());
    assert.equal(await store.load(), undefined);
    await store.save({ seq: 1 });
    await store.save({ seq: 2 });
    assert.deepEqual(await store.load(), { seq: 2 });
    assert.deepEqual(await fs.readdir(dir), ["writer.json"]);
    await store.clear();
    assert.equal(await store.load(), undefined);
    await store.clear();
  });

  it("keeps the previous checkpoint when a save fails before replacing it", async (t) => {
    const dir = await directory(t);
    const path = join(dir, "writer.json");
    let failRename = false;
    const flaky: FileStoreFileSystem = {
      readFile: (file, encoding) => fs.readFile(file, encoding),
      open: (file, flags) => fs.open(file, flags),
      rm: (file, options) => fs.rm(file, options),
      async rename(from, to) {
        if (failRename) throw new Error("disk full");
        await fs.rename(from, to);
      },
    };
    const store = await openFileStore(path, { fs: flaky });
    t.after(() => store.close());
    await store.save({ seq: 1 });
    failRename = true;
    await assert.rejects(store.save({ seq: 2, padding: "x".repeat(10_000) }), /disk full/);
    assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), { seq: 1 }, "the file was never partly written");
    assert.deepEqual(await fs.readdir(dir), ["writer.json"], "the temporary file was removed");
  });

  it("finishes a save that was running at close before a reopened store can write", async (t) => {
    const dir = await directory(t);
    const path = join(dir, "writer.json");
    let releaseRename = () => {};
    const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    let slowRename = true;
    const slow: FileStoreFileSystem = {
      readFile: (file, encoding) => fs.readFile(file, encoding),
      open: (file, flags) => fs.open(file, flags),
      rm: (file, options) => fs.rm(file, options),
      async rename(from, to) {
        if (slowRename) { slowRename = false; await renameGate; }
        await fs.rename(from, to);
      },
    };
    const first = await openFileStore(path, { fs: slow });
    const stale = first.save({ seq: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20)); // The old save now waits inside rename.
    first.close(); // For example a client stopping while its save is still running.
    await assert.rejects(first.save({ seq: 9 }), /closed/);
    // Reopen and save at once; the stalled old save is released only afterwards.
    const racing = (async () => {
      const second = await openFileStore(path); // Waits for the running save instead of overlapping it.
      await second.save({ seq: 2 });
      return second;
    })();
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseRename();
    const second = await racing;
    t.after(() => second.close());
    await stale;
    assert.deepEqual(await second.load(), { seq: 2 }, "the older save never lands after the newer one");
  });

  it("reports a corrupt file instead of treating it as empty, and refuses a second open in this process", async (t) => {
    const dir = await directory(t);
    const path = join(dir, "writer.json");
    await fs.writeFile(path, "{not json");
    const store = await openFileStore(path);
    await assert.rejects(store.load(), /not valid JSON/);
    await assert.rejects(openFileStore(join(dir, ".", "writer.json")), CheckpointLockedError);
    store.close();
    const again = await openFileStore(path);
    again.close();
    await assert.rejects(openFileStore(""), TypeError);
  });
});

describe("connectSync with a store", () => {
  it("restores pending work after a reload and sends it exactly once", async (t) => {
    const h = harness(), db = idb(t);
    const before = await connectSync(Board, { transport: h.transport(), pollInterval: 0, store: await db.open() });
    const release = h.hold();
    before.doc.state.items.push("sent before the reload");
    await tick(); await tick();
    assert.equal(h.submitted.length, 1, "the first submission is waiting on the network");
    before.doc.state.items.push("typed while waiting");
    await tick(); await tick();
    // The page reloads while the request is still open.
    before.stop();
    release();
    await tick();
    const after = await connectSync(Board, { transport: h.transport(), pollInterval: 0, store: await db.open() });
    t.after(() => after.stop());
    assert.equal(after.doc.checkpoint().clientId, before.doc.checkpoint().clientId, "same writer");
    assert.deepEqual(after.doc.state.items.toArray(), ["sent before the reload", "typed while waiting"]);
    assert.equal(await after.sync(), true);
    assert.deepEqual(h.server.snapshot().data.items.values, ["sent before the reload", "typed while waiting"]);
    assert.deepEqual(h.submitted.filter((entry) => entry.endsWith(":1")).length, 1, "the first batch was sent once");
  });

  it("saves every local edit even while a pass waits on the network", async (t) => {
    const h = harness(), db = idb(t);
    const store = await db.open();
    const client = await connectSync(Board, { transport: h.transport(), pollInterval: 0, store });
    t.after(() => client.stop());
    const release = h.hold();
    client.doc.state.items.push("first");
    await tick(); await tick();
    client.doc.state.items.push("second");
    client.doc.state.count.value = 3;
    await tick(); await tick();
    const saved = decodeClientCheckpoint(Board, await store.load());
    assert.equal(saved.lastLocalSeq, 3);
    assert.equal(saved.pendingBatches.length, 3, "edits made during the stalled submission are stored");
    release();
    assert.equal(await client.sync(), true);
  });

  it("never lets an older checkpoint overwrite a newer one when saves are slow", async (t) => {
    const h = harness();
    const writes: number[] = [];
    let active = 0;
    const slow: CheckpointStore = {
      async load() { return undefined; },
      async save(checkpoint) {
        active++;
        assert.equal(active, 1, "saves never overlap");
        await new Promise((resolve) => setTimeout(resolve, 5));
        writes.push(decodeClientCheckpoint(Board, wire(checkpoint)).lastLocalSeq);
        active--;
      },
      async clear() {},
      close() {},
    };
    const client = await connectSync(Board, { transport: h.transport(), pollInterval: 0, store: slow });
    t.after(() => client.stop());
    for (let index = 0; index < 5; index++) {
      client.doc.state.items.push(String(index));
      await tick();
    }
    assert.equal(await client.sync(), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(writes, writes.toSorted((a, b) => a - b), "saved sequences never go backwards");
    assert.equal(writes.at(-1), 5);
  });

  it("fails the client when a save fails, rejects invalid stored data and invalid option combinations", async (t) => {
    const h = harness(), db = idb(t);
    let broken = false;
    const store = await db.open();
    const failing: CheckpointStore = {
      load: () => store.load(),
      async save(checkpoint) { if (broken) throw new Error("quota exceeded"); await store.save(checkpoint); },
      clear: () => store.clear(),
      close: () => store.close(),
    };
    const client = await connectSync(Board, { transport: h.transport(), pollInterval: 0, store: failing });
    broken = true;
    client.doc.state.items.push("x");
    await tick(); await tick(); await tick();
    assert.equal(client.status, "failed");
    assert.match(String(client.error), /quota exceeded/);
    client.stop();

    const corrupt = await db.open("corrupt");
    await corrupt.save({ clientId: "client-1" });
    await assert.rejects(connectSync(Board, { transport: h.transport(), pollInterval: 0, store: corrupt }));

    const other = await db.open("other");
    await assert.rejects(connectSync(Board, { transport: h.transport(), store: other, save() {} }), TypeError);
  });

  it("releases the store's lock when the client stops", async (t) => {
    const h = harness(), db = idb(t);
    const client = await connectSync(Board, { transport: h.transport(), pollInterval: 0, store: await db.open() });
    await assert.rejects(db.open(), CheckpointLockedError);
    client.stop();
    const reopened = await db.open();
    assert.equal(decodeClientCheckpoint(Board, await reopened.load()).clientId, client.doc.checkpoint().clientId);
  });

  it("restarts from a snapshot into the same store, replacing the old session's checkpoint", async (t) => {
    const h = harness(), db = idb(t);
    const server = createServer(Board, { historyLimit: 0 });
    const transport: SyncTransport = {
      async register() { return { clientId: server.openClient(), snapshot: wire(server.snapshot()) }; },
      async submit(batch) { server.receive(decodeClientBatch(Board, wire(batch))); },
      async reject(batch) { server.reject(decodeClientBatch(Board, wire(batch))); },
      async commitsSince(watermark) { return wire(server.commitsSince(watermark)); },
    };
    void h;
    const store = await db.open();
    const first = await connectSync(Board, { transport, pollInterval: 0, store });
    const peer = server.openClient();
    server.receive({ clientId: peer, seq: 1, operations: [{ type: "value/set", path: "count", value: 1 }] });
    assert.equal(await first.sync(), false);
    assert.equal(first.status, "gap");
    const next = await first.restartFromSnapshot();
    t.after(() => next.stop());
    assert.equal(first.status, "stopped");
    assert.notEqual(next.doc.checkpoint().clientId, first.doc.checkpoint().clientId);
    assert.equal(next.doc.state.count.value, 1);
    const saved = decodeClientCheckpoint(Board, await store.load());
    assert.equal(saved.clientId, next.doc.checkpoint().clientId, "the new session replaced the old one");
    await assert.rejects(db.open(), CheckpointLockedError, "the new client still holds the lock");
  });
});
