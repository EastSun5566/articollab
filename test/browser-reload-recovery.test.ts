import { decodeSnapshot } from "../src/index.ts";
import { decodeClientBatch } from "../src/index.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before as setup, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createServer, type ClientCheckpoint, type ClientDocument, type CreateServerOptions } from "../src/index.ts";
import { startBrowserReloadRecoveryServer } from "../examples/browser-reload-recovery/server.ts";
import { startHttpExampleServer } from "../examples/http-sync.ts";
import { Board } from "../examples/resume.ts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const recoveryUrl = new URL("../examples/browser-reload-recovery/recovery.js", import.meta.url).href;
const browserUrl = new URL("../examples/browser-http-smoke/smoke.js", import.meta.url).href;
const key = "articollab:browser-reload-recovery:checkpoint";
type Shape = typeof Board.definition;
type Checkpoint = ClientCheckpoint<Shape>;
type Record = { documentId: string; checkpoint: Checkpoint };
type Client = ClientDocument<Shape>;
type Storage = { getItem(this: void, key: string): string | null; setItem(key: string, value: string): void };
type Connection = { doc: Client; documentId: string; sync(): Promise<boolean>; rejectPending(): Promise<boolean> };
let recovery: {
  createSessionCheckpointStore(storage: Storage): { load(): Record | null; save(record: Record): undefined };
  connectPersistentBrowserClient(url: string, options?: { storage?: Storage; fetch?: typeof globalThis.fetch }): Promise<Connection>;
};
let browser: { connectBrowserHttpClient(url: string, clientId: string, options?: {
  checkpoint?: Checkpoint; saveClientCheckpoint?: (checkpoint: Checkpoint) => undefined;
}): Promise<Connection> };

function memory() {
  let message: string | null = null;
  const writes: string[] = [];
  return {
    getItem(this: void, name: string) { assert.equal(name, key); return message; },
    setItem(name: string, value: string) { assert.equal(name, key); message = value; writes.push(value); },
    writes,
  };
}

async function host(t: TestContext, options: CreateServerOptions<Shape> = {}) {
  const server = createServer(Board, options);
  const http = await startHttpExampleServer(server, { documentId: crypto.randomUUID() });
  t.after(() => http.close());
  return { server, url: http.url };
}

function mixed(doc: Client): void {
  const seq = doc.checkpoint().lastLocalSeq + 1;
  doc.transact(() => {
    doc.state.count.value += 1;
    doc.state.items.push("Draft " + seq);
    doc.state.body.insert(doc.state.body.length, "Hi😀");
  });
}

function visible(doc: Client) {
  return { count: doc.state.count.value, items: doc.state.items.toArray(), body: doc.state.body.toString() };
}

describe("browser checkpoint reload recovery", { timeout: 30_000 }, () => {
  setup(async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deferred import of repository-owned JS after build; its interface is independently JSDoc-checked.
    recovery = (await import(new URL("../examples/browser-reload-recovery/recovery.js", import.meta.url).href)) as typeof recovery;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deferred import of repository-owned JS after build; its interface is independently JSDoc-checked.
    browser = (await import(browserUrl)) as typeof browser;
  });

  it("saves fresh and offline mixed checkpoints, then restores without requests or submissions", async (t) => {
    const { server, url } = await host(t);
    const storage = memory();
    const paths: string[] = [];
    const a = await recovery.connectPersistentBrowserClient(url, { storage, fetch: async (input, init) => {
      paths.push(new URL((input instanceof Request ? input.url : input.toString())).pathname);
      return fetch(input, init);
    } });
    assert.deepEqual(paths, ["/snapshot"]);
    assert.equal(storage.writes.length, 1);
    assert.match(a.doc.checkpoint().clientId, /^browser-recovery-/);
    mixed(a.doc);
    mixed(a.doc);
    assert.deepEqual(paths, ["/snapshot"]);
    assert.equal(server.snapshot().serverSeq, 0);
    const saved = recovery.createSessionCheckpointStore(storage).load()!.checkpoint;
    assert.deepEqual(saved, a.doc.checkpoint());
    assert.deepEqual(saved.pendingBatches.map((batch) => batch.seq), [1, 2]);
    assert.equal(a.doc.state.body.length, 6);
    const b = await recovery.connectPersistentBrowserClient(url, { storage, fetch: async () => {
      throw new Error("Restore must not request a snapshot or submit");
    } }); // The old writer is retired.
    assert.deepEqual(b.doc.checkpoint(), saved);
    assert.deepEqual(visible(b.doc), visible(a.doc));
    assert.equal(storage.writes.length, 4); // Creation, two local batches, restored creation.
    assert.deepEqual(paths, ["/snapshot"]);
  });

  it("saves silent acks and tombstones, then continues sequences and IDs after restore", async (t) => {
    const { server, url } = await host(t);
    const storage = memory();
    let a = await recovery.connectPersistentBrowserClient(url, { storage });
    let serverChanges = 0;
    a.doc.on("change", (event) => { if (event.origin === "server") serverChanges++; });
    mixed(a.doc);
    assert.equal(await a.sync(), true);
    assert.equal(serverChanges, 0);
    assert.equal(storage.writes.length, 3); // Initial, local, silent ack.
    a.doc.transact(() => { a.doc.state.items.delete(0); a.doc.state.body.delete(0, 3); });
    assert.equal(await a.sync(), true);
    const saved = recovery.createSessionCheckpointStore(storage).load()!.checkpoint;
    assert.deepEqual(saved.snapshot, server.snapshot());
    assert.deepEqual(saved.snapshot.data.items.values, []);
    assert.equal(saved.snapshot.data.body.value, "");
    assert.ok(saved.snapshot.data.items.idList.length > 0);
    assert.ok(saved.snapshot.data.body.idList.length > 0);
    a = await recovery.connectPersistentBrowserClient(url, { storage });
    assert.deepEqual(a.doc.checkpoint(), saved);
    mixed(a.doc);
    assert.equal(a.doc.checkpoint().pendingBatches[0]!.seq, saved.lastLocalSeq + 1);
    assert.ok(a.doc.checkpoint().lastBunchSeqs.items > saved.lastBunchSeqs.items);
    assert.ok(a.doc.checkpoint().lastBunchSeqs.body > saved.lastBunchSeqs.body);
    assert.equal(await a.sync(), true);
    assert.deepEqual(recovery.createSessionCheckpointStore(storage).load()?.checkpoint, a.doc.checkpoint());
    assert.deepEqual(a.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(visible(a.doc), { count: 2, items: ["Draft 3"], body: "Hi😀" });
  });

  it("catches a saved accepted result after a lost POST response without resubmitting it", async (t) => {
    let resolves = 0;
    const { server, url } = await host(t, { resolve: ({ batch }) => { resolves++; return batch.operations; } });
    const storage = memory();
    const failure = new Error("Accepted POST response lost");
    const a = await recovery.connectPersistentBrowserClient(url, { storage, fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === "POST") { await response.text(); throw failure; }
      return response;
    } });
    mixed(a.doc);
    mixed(a.doc);
    await assert.rejects(a.sync(), (error: unknown) => error === failure);
    await assert.rejects(a.rejectPending(), (error: unknown) => error === failure);
    assert.equal(server.snapshot().serverSeq, 1);
    assert.deepEqual(recovery.createSessionCheckpointStore(storage).load()!.checkpoint.pendingBatches.map((batch) => batch.seq), [1, 2]);
    const posts: number[] = [];
    const b = await recovery.connectPersistentBrowserClient(url, { storage, fetch: async (input, init) => {
      if (init?.method === "POST") posts.push(decodeClientBatch(Board, JSON.parse(typeof init.body === "string" ? init.body : assert.fail("Expected JSON request body"))).seq);
      return fetch(input, init);
    } });
    assert.equal(await b.sync(), true);
    assert.deepEqual(posts, [2]);
    assert.equal(resolves, 2);
    assert.equal(server.snapshot().serverSeq, 2);
    assert.deepEqual(b.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(b.doc.checkpoint().pendingBatches, []);
    assert.deepEqual(recovery.createSessionCheckpointStore(storage).load()?.checkpoint, b.doc.checkpoint());
  });

  it("stops after local save failure and preserves the previous stored work without submitting", async (t) => {
    const { server, url } = await host(t);
    const storage = memory();
    const failure = new Error("Storage quota exhausted");
    let fail = false;
    let posts = 0;
    const failing: Storage = { getItem: storage.getItem, setItem(name, message) {
      if (fail) throw failure;
      storage.setItem(name, message);
    } };
    const a = await recovery.connectPersistentBrowserClient(url, { storage: failing, fetch: async (input, init) => {
      if (init?.method === "POST") posts++;
      return fetch(input, init);
    } });
    mixed(a.doc);
    const lastSaved = storage.getItem(key);
    fail = true;
    assert.throws(() => mixed(a.doc), (error: unknown) => error === failure);
    assert.equal(storage.getItem(key), lastSaved);
    assert.deepEqual(a.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [1, 2]);
    await assert.rejects(a.sync(), (error: unknown) => error === failure);
    await assert.rejects(a.rejectPending(), (error: unknown) => error === failure);
    assert.equal(posts, 0);
    assert.equal(server.snapshot().serverSeq, 0);
    const b = await recovery.connectPersistentBrowserClient(url, { storage });
    assert.deepEqual(b.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [1]);
    assert.equal(await b.sync(), true); // Only successfully stored work is recoverable.
    assert.deepEqual(visible(b.doc), { count: 1, items: ["Draft 1"], body: "Hi😀" });
  });

  it("recovers an applied-but-unsaved ack and preserves listener failure before any later save", async (t) => {
    for (const mode of ["storage", "listener"] as const) {
      const { server, url } = await host(t, mode === "listener" ? {
        resolve: ({ batch }) => [...batch.operations, { type: "value/set", path: "count", value: 99 }],
      } : {});
      const storage = memory();
      const failure = new Error(mode + " failed");
      let fail = false;
      let saves = 0;
      const a = await recovery.connectPersistentBrowserClient(url, { storage: {
        getItem: storage.getItem, setItem(name, message) {
          saves++;
          if (fail) throw failure;
          storage.setItem(name, message);
        },
      } });
      mixed(a.doc);
      const saved = storage.getItem(key);
      fail = true;
      if (mode === "listener") a.doc.on("change", () => { throw failure; });
      await assert.rejects(a.sync(), (error: unknown) => error === failure);
      assert.equal(a.doc.checkpoint().snapshot.serverSeq, 1);
      assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
      assert.equal(storage.getItem(key), saved);
      assert.equal(saves, mode === "listener" ? 2 : 3); // A throwing listener prevents the ack save.
      await assert.rejects(a.sync(), (error: unknown) => error === failure);
      let posts = 0;
      const b = await recovery.connectPersistentBrowserClient(url, { storage, fetch: async (input, init) => {
        if (init?.method === "POST") posts++;
        return fetch(input, init);
      } });
      assert.equal(await b.sync(), true);
      assert.equal(posts, 0);
      assert.deepEqual(b.doc.checkpoint().snapshot, server.snapshot());
      assert.deepEqual(recovery.createSessionCheckpointStore(storage).load()?.checkpoint, b.doc.checkpoint());
    }
  });

  it("rejects corrupt data and storage/bootstrap errors without clearing or falling back", async (t) => {
    const { server, url } = await host(t);
    const noRequest: typeof fetch = async () => { throw new Error("Unexpected fallback request"); };
    for (const message of ["", "{broken", "null", "{}", JSON.stringify({ clientId: "", snapshot: server.snapshot() })]) {
      let writes = 0;
      const storage: Storage = { getItem: () => message, setItem() { writes++; } };
      assert.throws(() => recovery.createSessionCheckpointStore(storage).load());
      await assert.rejects(recovery.connectPersistentBrowserClient(url, { storage, fetch: noRequest }),
        (error: unknown) => error instanceof Error && error.message !== "Unexpected fallback request");
      assert.equal(writes, 0);
      assert.equal(storage.getItem(key), message);
    }
    const readFailure = new Error("Storage access denied");
    await assert.rejects(recovery.connectPersistentBrowserClient(url, { storage: {
      getItem() { throw readFailure; }, setItem() { throw new Error("Unexpected write"); },
    }, fetch: noRequest }), (error: unknown) => error === readFailure);
    const writeFailure = new Error("Initial checkpoint cannot be saved");
    const paths: string[] = [];
    await assert.rejects(recovery.connectPersistentBrowserClient(url, { storage: {
      getItem: () => null, setItem() { throw writeFailure; },
    }, fetch: async (input, init) => { paths.push(new URL((input instanceof Request ? input.url : input.toString())).pathname); return fetch(input, init); } }),
    (error: unknown) => error === writeFailure);
    assert.deepEqual(paths, ["/snapshot"]);
    assert.equal(server.snapshot().serverSeq, 0);
    const storage = memory();
    const callbackFailure = new Error("Synchronous callback failed");
    await assert.rejects(browser.connectBrowserHttpClient(url, "callback", { saveClientCheckpoint() { throw callbackFailure; } }),
      (error: unknown) => error === callbackFailure);
    const restored = await recovery.connectPersistentBrowserClient(url, { storage });
    const serialized = new Error("Serialization failed");
    const stringify = t.mock.method(JSON, "stringify", () => { throw serialized; });
    try {
      assert.throws(() => recovery.createSessionCheckpointStore(storage).save({ documentId: restored.documentId, checkpoint: restored.doc.checkpoint() }),
        (error: unknown) => error === serialized);
      assert.equal(storage.writes.length, 1);
    } finally { stringify.mock.restore(); }
  });

  it("preserves history-gap work and restores blocked pending for explicit cancellation", async (t) => {
    {
      const { server, url } = await host(t, { historyLimit: 0 });
      const storage = memory();
      let a = await recovery.connectPersistentBrowserClient(url, { storage });
      mixed(a.doc);
      server.receive({ clientId: "peer", seq: 1, operations: [{ type: "value/set", path: "count", value: 10 }] });
      a = await recovery.connectPersistentBrowserClient(url, { storage });
      const saved = storage.getItem(key);
      assert.equal(await a.sync(), false);
      assert.equal(await a.rejectPending(), false);
      assert.equal(storage.getItem(key), saved);
      assert.equal(a.doc.checkpoint().snapshot.serverSeq, 0);
      assert.deepEqual(a.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [1]);
      assert.equal(server.snapshot().serverSeq, 1);
    }
    {
      const { server, url } = await host(t, { resolve: ({ batch }) => batch.seq === 1 ? [] : batch.operations });
      const storage = memory();
      let a = await recovery.connectPersistentBrowserClient(url, { storage });
      mixed(a.doc);
      mixed(a.doc); // Its insertions depend on IDs in the first batch.
      assert.equal(await a.sync(), false);
      assert.equal(a.doc.replayConflict?.batch.seq, 2);
      const saved = a.doc.checkpoint();
      const before = visible(a.doc);
      a = await recovery.connectPersistentBrowserClient(url, { storage });
      assert.deepEqual(a.doc.checkpoint(), saved);
      assert.deepEqual(visible(a.doc), before);
      assert.equal(a.doc.replayConflict?.batch.seq, 2);
      assert.equal(await a.rejectPending(), true);
      assert.equal(a.doc.replayConflict, null);
      assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
      assert.deepEqual(recovery.createSessionCheckpointStore(storage).load()?.checkpoint, a.doc.checkpoint());
      mixed(a.doc);
      assert.equal(await a.sync(), true);
      assert.equal(a.doc.checkpoint().lastLocalSeq, 3);
      assert.deepEqual(a.doc.checkpoint().snapshot, server.snapshot());
    }
  });

  it("hosts only fixed assets and imports without DOM, storage, network or demo side effects", async (t) => {
    const http = await startBrowserReloadRecoveryServer();
    t.after(() => http.close());
    for (const [path, file, mime] of [
      ["/", "examples/browser-reload-recovery/index.html", "text/html"],
      ["/browser-reload-recovery/recovery.js", "examples/browser-reload-recovery/recovery.js", "text/javascript"],
      ["/browser-http-smoke/smoke.js", "examples/browser-http-smoke/smoke.js", "text/javascript"],
      ["/http-sync-controller.js", "examples/http-sync-controller.js", "text/javascript"],
      ["/dist/index.js", "dist/index.js", "text/javascript"],
    ] as const) {
      const response = await fetch(http.url + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Type"), mime + "; charset=utf-8");
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(await response.text(), readFileSync(join(root, file), "utf8"));
    }
    const response = await fetch(http.url + "/snapshot");
    assert.equal(decodeSnapshot(Board, await response.json()).serverSeq, 0);
    for (const path of ["/src/index.ts", "/package.json", "/dist/index.d.ts", "/unknown"]) {
      const missing = await fetch(http.url + path);
      assert.equal(missing.status, 404);
      await missing.text();
    }
    const serverUrl = new URL("../examples/browser-reload-recovery/server.ts", import.meta.url).href;
    const code = `
      const { Server } = await import("node:http");
      Server.prototype.listen = () => { throw new Error("Unexpected listen"); };
      globalThis.fetch = () => { throw new Error("Unexpected fetch"); };
      for (const name of ["window", "document", "sessionStorage"]) {
        Object.defineProperty(globalThis, name, { get() { throw new Error("Unexpected " + name); } });
      }
      await import(${JSON.stringify(recoveryUrl)});
      await import(${JSON.stringify(serverUrl)});
    `;
    const result = await execute(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", code],
      { cwd: root, timeout: 10_000 });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});
