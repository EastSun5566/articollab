import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createServer, type ClientBatch, type ClientDocument, type DocumentOperation } from "../src/index.ts";
import { startBrowserReloadRecoveryServer } from "../examples/browser-reload-recovery/server.ts";
import { startHttpExampleServer } from "../examples/http-sync.ts";
import { createCheckpointStore } from "../examples/persistent-resume.ts";
import { Board } from "../examples/resume.ts";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "examples/browser-reload-recovery/server.ts");
const recoveryUrl = new URL("../examples/browser-reload-recovery/recovery.js", import.meta.url).href;
const key = "articollab:browser-reload-recovery:checkpoint";
type Shape = typeof Board.definition;
type Client = ClientDocument<Shape>;
type Batch = ClientBatch<DocumentOperation<Shape>>;
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
type Connection = { doc: Client; sync(): Promise<boolean>; rejectPending(): Promise<boolean> };
type BrowserOptions = { storage: Storage; fetch?: typeof globalThis.fetch };
let connectBrowser: (url: string, options: BrowserOptions) => Promise<Connection>;
const fetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("Connection", "close"); // Test requests must not reuse retired hosts' keep-alive sockets.
  return globalThis.fetch(input, { ...init, headers });
};
function connect(url: string, options: BrowserOptions): Promise<Connection> {
  return connectBrowser(url, { fetch, ...options });
}

function memory(): Storage {
  let message: string | null = null;
  return {
    getItem(name) { assert.equal(name, key); return message; },
    setItem(name, value) { assert.equal(name, key); message = value; },
  };
}

function mixed(doc: Client): void {
  const seq = doc.checkpoint().lastLocalSeq + 1;
  doc.transact(() => {
    doc.state.count.value += 1;
    doc.state.items.push("Draft " + seq);
    doc.state.body.insert(doc.state.body.length, "Hi😀");
  });
}

function port(url: string): number { return Number(new URL(url).port); }

async function post(url: string, path: string, batch: Batch): Promise<number> {
  const response = await fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch) });
  await response.text();
  return response.status;
}

function resources(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "articollab-browser-server-"));
  const closers: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    try { for (const close of closers.toReversed()) await close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return {
    directory,
    store: createCheckpointStore(directory),
    async start(port?: number) {
      const host = await startBrowserReloadRecoveryServer({ directory, ...(port === undefined ? {} : { port }) });
      closers.push(() => host.close());
      return host;
    },
    async child(args: string[]) {
      const child = spawn(process.execPath, [cli, ...args], { cwd: root, timeout: 15_000 });
      let stdout = "";
      let stderr = "";
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      async function stop(signal: NodeJS.Signals = "SIGKILL") {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        return closed;
      }
      closers.push(() => stop());
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Host startup timed out: " + stdout + stderr)); }, 5_000);
        function fail(error: Error) { clearTimeout(timer); reject(error); }
        child.once("error", fail);
        child.once("close", () => fail(new Error("Host exited before readiness: " + stdout + stderr)));
        child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
        child.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
          const match = /^Open (http:\/\/127\.0\.0\.1:\d+) in Chrome\./m.exec(stdout);
          if (match !== null) { clearTimeout(timer); resolve(match[1]!); }
        });
      });
      return { url, stop };
    },
  };
}

describe("browser and server checkpoint recovery", { timeout: 30_000 }, () => {
  before(async () => {
    const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
    await execute(process.execPath, [compiler, "-p", "tsconfig.build.json"], { cwd: root, timeout: 15_000 });
    ({ connectPersistentBrowserClient: connectBrowser } = await import(recoveryUrl));
  });

  it("preserves default hosting and validates ports before saving, without falling back on a busy port", async (t) => {
    const { directory } = resources(t);
    let saves = 0;
    for (const port of [-1, 0.5, NaN, Infinity, 65536, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(startHttpExampleServer(createServer(Board), { port, saveServerCheckpoint() { saves++; } }), /Invalid HTTP port/);
      await assert.rejects(startBrowserReloadRecoveryServer({ directory, port }), /Invalid HTTP port/);
    }
    assert.equal(saves, 0);
    assert.deepEqual(readdirSync(directory), []);
    const host = await startBrowserReloadRecoveryServer();
    try {
      assert.equal(new URL(host.url).hostname, "127.0.0.1");
      assert.ok(port(host.url) > 0);
      const page = await fetch(host.url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Persistent mode: restart with the same checkpoint/);
      const snapshot = await fetch(host.url + "/snapshot");
      assert.equal((await snapshot.json()).serverSeq, 0);
      await assert.rejects(startBrowserReloadRecoveryServer({ port: port(host.url) }), { code: "EADDRINUSE" });
      assert.deepEqual(readdirSync(directory), []);
    } finally { await host.close(); }
  });

  it("restores mixed pending, tombstones and allocation progress at the same origin", async (t) => {
    const { start, store, directory } = resources(t);
    let host = await start();
    assert.equal(store.loadServer()!.snapshot.serverSeq, 0); // Saved before the host became available.
    const storage = memory();
    let a = await connect(host.url, { storage });
    let changes = 0;
    a.doc.on("change", (event) => { if (event.origin === "server") changes++; });
    mixed(a.doc);
    assert.equal(await a.sync(), true);
    assert.equal(changes, 0); // Silent own ack still saves both checkpoints.
    a.doc.transact(() => { a.doc.state.items.delete(0); a.doc.state.body.delete(0, 3); });
    assert.equal(await a.sync(), true);
    const authoritative = store.loadServer()!;
    assert.deepEqual(authoritative.snapshot.data.items.values, []);
    assert.equal(authoritative.snapshot.data.body.value, "");
    assert.ok(authoritative.snapshot.data.items.idList.length > 0);
    assert.ok(authoritative.snapshot.data.body.idList.length > 0);
    mixed(a.doc);
    mixed(a.doc);
    const saved = a.doc.checkpoint();
    const origin = host.url;
    await host.close();
    host = await start(port(origin));
    assert.equal(host.url, origin);
    assert.deepEqual(store.loadServer(), authoritative);
    const requests: string[] = [];
    a = await connect(origin, { storage, fetch: async (input, init) => {
      requests.push(init?.method === "POST" ? "POST" : new URL(String(input)).pathname);
      return fetch(input, init);
    } });
    assert.deepEqual(requests, []);
    assert.deepEqual(a.doc.checkpoint(), saved);
    assert.deepEqual(a.doc.state.items.toArray(), ["Draft 3", "Draft 4"]);
    assert.equal(a.doc.state.body.toString(), "Hi😀Hi😀");
    assert.equal(await a.sync(), true);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
    mixed(a.doc);
    assert.equal(a.doc.checkpoint().lastLocalSeq, 5);
    assert.ok(a.doc.checkpoint().lastBunchSeqs.items > saved.lastBunchSeqs.items);
    assert.ok(a.doc.checkpoint().lastBunchSeqs.body > saved.lastBunchSeqs.body);
    assert.equal(await a.sync(), true);
    assert.deepEqual(a.doc.checkpoint().snapshot, store.loadServer()!.snapshot);
    assert.deepEqual(JSON.parse(storage.getItem(key)!), a.doc.checkpoint());
    const peer = await connect(origin, { storage: memory() });
    assert.deepEqual(peer.doc.checkpoint().snapshot, a.doc.checkpoint().snapshot);
    for (const path of ["/server.json", "/server.json.tmp", "/src/index.ts"]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 404);
      await response.text();
    }
    assert.deepEqual(readdirSync(directory), ["server.json"]); // No host-owned client files.
  });

  it("preserves rejection, blocked suffix and cross-entry retry through server restart", async (t) => {
    const { start, store } = resources(t);
    let host = await start();
    const storage = memory();
    let a = await connect(host.url, { storage });
    mixed(a.doc);
    mixed(a.doc);
    const first = a.doc.checkpoint().pendingBatches[0]!;
    assert.equal(await post(host.url, "/rejections", first), 204);
    assert.equal(await a.sync(), false);
    assert.equal(a.doc.replayConflict?.batch.seq, 2);
    const saved = a.doc.checkpoint();
    const allocation = saved.lastBunchSeqs;
    const peer: Batch = { clientId: "peer", seq: 1, operations: [{ type: "value/set", path: "count", value: 10 }] };
    assert.equal(await post(host.url, "/batches", peer), 204);
    const before = store.loadServer();
    assert.equal(await post(host.url, "/batches", first), 204); // A rejection cannot become acceptance.
    assert.deepEqual(store.loadServer(), before);
    const origin = host.url;
    await host.close();
    host = await start(port(origin));
    a = await connect(origin, { storage });
    assert.deepEqual(a.doc.checkpoint(), saved);
    assert.equal(a.doc.replayConflict?.batch.seq, 2);
    assert.equal(await post(origin, "/batches", first), 204);
    assert.deepEqual(store.loadServer(), before);
    assert.equal(await a.rejectPending(), true);
    assert.equal(a.doc.replayConflict, null);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
    assert.deepEqual(a.doc.checkpoint().lastBunchSeqs, allocation);
    assert.equal(a.doc.state.count.value, 10);
    assert.deepEqual(a.doc.state.items.toArray(), []);
    assert.equal(a.doc.state.body.toString(), "");
    mixed(a.doc);
    assert.equal(a.doc.checkpoint().lastLocalSeq, 3);
    assert.equal(await a.sync(), true);
    assert.deepEqual(a.doc.checkpoint().snapshot, store.loadServer()!.snapshot);
    assert.deepEqual(JSON.parse(storage.getItem(key)!), a.doc.checkpoint());
  });

  it("recovers a lost POST ack after actual CLI process termination without resubmitting the accepted batch", async (t) => {
    const { start, child, store, directory } = resources(t);
    const initial = await start();
    const origin = initial.url;
    await initial.close();
    let host = await child([directory, String(port(origin))]);
    assert.equal(host.url, origin);
    const storage = memory();
    const lost = new Error("Accepted POST response lost");
    let a = await connect(origin, { storage, fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === "POST") { await response.text(); throw lost; }
      return response;
    } });
    mixed(a.doc);
    mixed(a.doc);
    await assert.rejects(a.sync(), (error: unknown) => error === lost);
    assert.equal(store.loadServer()!.snapshot.serverSeq, 1);
    const saved = a.doc.checkpoint();
    assert.deepEqual(saved.pendingBatches.map((batch) => batch.seq), [1, 2]);
    assert.deepEqual(await host.stop("SIGKILL"), { code: null, signal: "SIGKILL" });
    host = await child([directory, String(port(origin))]);
    assert.equal(host.url, origin);
    const posts: number[] = [];
    let gets = 0;
    a = await connect(origin, { storage, fetch: async (input, init) => {
      if (init?.method === "POST") posts.push((JSON.parse(String(init.body)) as Batch).seq);
      else gets++;
      return fetch(input, init);
    } });
    assert.equal(gets, 0);
    assert.deepEqual(a.doc.checkpoint(), saved);
    assert.equal(await a.sync(), true);
    assert.deepEqual(posts, [2]);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
    assert.equal(store.loadServer()!.snapshot.serverSeq, 2);
    const checkpoint = store.loadServer();
    assert.equal(await post(origin, "/rejections", saved.pendingBatches[1]!), 204); // Acceptance remains acceptance on retry.
    assert.deepEqual(store.loadServer(), checkpoint);
    mixed(a.doc);
    assert.equal(await a.sync(), true);
    assert.deepEqual(posts, [2, 3]);
    assert.deepEqual(a.doc.checkpoint().snapshot, store.loadServer()!.snapshot);
    assert.deepEqual(await host.stop("SIGINT"), { code: 0, signal: null });
  });

  it("stops on server saving failure, restores only disk state and does not save retries", async (t) => {
    const { start, store, directory } = resources(t);
    let host = await start();
    const origin = host.url;
    const temporary = join(directory, "server.json.tmp");
    const storage = memory();
    let a = await connect(origin, { storage });
    mixed(a.doc);
    const saved = a.doc.checkpoint();
    const before = store.loadServer();
    mkdirSync(temporary); // Deterministic write failure without platform-dependent chmod assumptions.
    await assert.rejects(a.sync(), /Unexpected HTTP status: 500/);
    assert.deepEqual(store.loadServer(), before);
    assert.deepEqual(JSON.parse(storage.getItem(key)!), saved);
    const stopped = await fetch(origin + "/snapshot");
    assert.equal(stopped.status, 503);
    await stopped.text();
    await host.close();
    rmSync(temporary, { recursive: true });
    host = await start(port(origin));
    a = await connect(origin, { storage });
    assert.equal(await a.sync(), true);
    assert.deepEqual(a.doc.checkpoint().snapshot, store.loadServer()!.snapshot);
    const accepted = store.loadServer();
    mkdirSync(temporary);
    assert.equal(await post(origin, "/rejections", saved.pendingBatches[0]!), 204); // Would fail if retry attempted a save.
    assert.deepEqual(store.loadServer(), accepted);
    const healthy = await fetch(origin + "/snapshot");
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), accepted!.snapshot);
  });

  it("does not replace corrupt checkpoints or hide directory/bootstrap saving failures", async (t) => {
    const { start, store, directory } = resources(t);
    const host = await start();
    const origin = host.url;
    await host.close();
    const valid = store.loadServer()!;
    const path = join(directory, "server.json");
    for (const message of ["{broken", "{}", JSON.stringify({ ...valid, snapshot: { ...valid.snapshot, serverSeq: 1 } })]) {
      writeFileSync(path, message);
      await assert.rejects(start(port(origin)));
      assert.equal(readFileSync(path, "utf8"), message);
    }
    await assert.rejects(startBrowserReloadRecoveryServer({ directory: join(directory, "missing") }), { code: "ENOENT" });
    await assert.rejects(startBrowserReloadRecoveryServer({ directory: path }), /must be a directory/);
    store.saveServer(valid);
    writeFileSync(path + ".tmp", "orphan, not a checkpoint");
    const recovered = await start(port(origin));
    assert.deepEqual(store.loadServer(), valid);
    await recovered.close();
    mkdirSync(path + ".tmp");
    await assert.rejects(start(port(origin)), { code: "EISDIR" });
    assert.deepEqual(store.loadServer(), valid);
    const available = await startBrowserReloadRecoveryServer({ port: port(origin) });
    await available.close(); // Bootstrap saving failure did not open a socket.
  });

  it("keeps pending and the saved browser checkpoint when restored server history cannot catch up", async (t) => {
    const { start, store } = resources(t);
    let host = await start();
    const storage = memory();
    let a = await connect(host.url, { storage });
    mixed(a.doc);
    const origin = host.url;
    await host.close();
    const server = createServer(Board, { historyLimit: 0 });
    server.receive({ clientId: "peer", seq: 1, operations: [{ type: "value/set", path: "count", value: 10 }] });
    store.saveServer(server.checkpoint()); // Same lineage; deliberately retained no catch-up history.
    host = await start(port(origin));
    let posts = 0;
    a = await connect(origin, { storage, fetch: async (input, init) => {
      if (init?.method === "POST") posts++;
      return fetch(input, init);
    } });
    const saved = storage.getItem(key);
    const checkpoint = a.doc.checkpoint();
    assert.equal(await a.sync(), false);
    assert.equal(await a.rejectPending(), false);
    assert.equal(posts, 0);
    assert.deepEqual(a.doc.checkpoint(), checkpoint);
    assert.equal(storage.getItem(key), saved);
    assert.equal(store.loadServer()!.snapshot.serverSeq, 1);
  });

  it("rejects invalid CLI arguments and preserves the no-argument in-memory mode and signal shutdown", async (t) => {
    const { directory, child } = resources(t);
    for (const args of [[directory], [directory, "0"], [directory, "65536"], [directory, "1.5"],
      [directory, "1e3"], [directory, "-1"], [directory, "3000", "extra"]]) {
      await assert.rejects(execute(process.execPath, [cli, ...args], { cwd: root, timeout: 5_000 }),
        (error: unknown) => error instanceof Error && "stderr" in error && String(error.stderr).includes("Usage:"));
    }
    assert.deepEqual(readdirSync(directory), []);
    const host = await child([]);
    const response = await fetch(host.url + "/snapshot");
    assert.equal((await response.json()).serverSeq, 0);
    assert.deepEqual(readdirSync(directory), []);
    assert.deepEqual(await host.stop("SIGTERM"), { code: 0, signal: null });
  });
});
