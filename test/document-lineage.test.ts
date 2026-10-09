import { decodeClientBatch } from "../src/index.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before as setup, describe, it, type TestContext } from "node:test";

import { createServer, type ClientCheckpoint, type ClientDocument } from "../src/index.ts";
import { startBrowserReloadRecoveryServer } from "../examples/browser-reload-recovery/server.ts";
import { startHttpExampleServer } from "../examples/http-sync.ts";
import { createCheckpointStore } from "../examples/persistent-resume.ts";
import { Board } from "../examples/resume.ts";

type Shape = typeof Board.definition;
type Record = { documentId: string; checkpoint: ClientCheckpoint<Shape> };
type Storage = { getItem(this: void, key: string): string | null; setItem(key: string, value: string): void };
type Connection = { doc: ClientDocument<Shape>; documentId: string; sync(): Promise<boolean>; rejectPending(): Promise<boolean> };
const key = "articollab:browser-reload-recovery:checkpoint";
const header = "X-Articollab-Document-Id";
let recovery: {
  createSessionCheckpointStore(storage: Storage): { load(): Record | null; save(record: Record): undefined };
  connectPersistentBrowserClient(url: string, options: { storage: Storage; fetch?: typeof fetch }): Promise<Connection>;
};
const fetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("Connection", "close");
  return globalThis.fetch(input, { ...init, headers });
};
function memory(): Storage {
  let message: string | null = null;
  return { getItem: () => message, setItem(_key, value) { message = value; } };
}
function mixed(doc: Connection["doc"]): void {
  doc.transact(() => { doc.state.count.value++; doc.state.items.push("A"); doc.state.body.insert(doc.state.body.length, "Hi😀"); });
}
function directory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "articollab-lineage-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function host(t: TestContext, port = 0) {
  let resolves = 0;
  let saves = 0;
  const documentId = crypto.randomUUID();
  const server = createServer(Board, { resolve: ({ batch }) => { resolves++; return batch.operations; } });
  const http = await startHttpExampleServer(server, { documentId, port, saveServerCheckpoint() { saves++; } });
  t.after(() => http.close());
  return { ...http, server, documentId, resolves: () => resolves, saves: () => saves };
}

describe("browser recovery document lineage", { timeout: 30_000 }, () => {
  setup(async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deferred import of repository-owned JS after build; its interface is independently JSDoc-checked.
    recovery = (await import(new URL("../examples/browser-reload-recovery/recovery.js", import.meta.url).href)) as typeof recovery;
  });

  it("rejects missing and wrong request identities before runtime, while preserving cross-entry retry", async (t) => {
    const h = await host(t);
    const batch = { clientId: h.server.openClient(), seq: 1, operations: [{ type: "value/set", path: "count", value: 5 }] };
    const before = h.server.checkpoint();
    for (const id of [undefined, "invalid", crypto.randomUUID()]) {
      for (const path of ["/commits?since=0", "/batches", "/rejections"]) {
        const response = await fetch(h.url + path, { method: path.startsWith("/commits") ? "GET" : "POST",
          headers: { "Content-Type": "application/json", ...(id === undefined ? {} : { [header]: id }) },
          ...(path.startsWith("/commits") ? {} : { body: JSON.stringify(batch) }),
        });
        assert.equal(response.status, 409);
        assert.equal(response.headers.get(header), h.documentId);
        assert.deepEqual(await response.json(), { error: "Document lineage mismatch" });
      }
    }
    assert.deepEqual(h.server.checkpoint(), before);
    assert.equal(h.resolves(), 0);
    assert.equal(h.saves(), 1);
    for (const path of ["/batches", "/rejections", "/batches"]) {
      const response = await fetch(h.url + path, { method: "POST", headers: { "Content-Type": "application/json", [header]: h.documentId }, body: JSON.stringify(batch) });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get(header), h.documentId);
      await response.text();
    }
    assert.equal(h.server.snapshot().data.count, 5);
    assert.equal(h.server.snapshot().serverSeq, 1);
    assert.equal(h.resolves(), 1);
    assert.equal(h.saves(), 2);
    let invalidSaves = 0;
    for (const documentId of ["", h.documentId + "\n", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"]) {
      await assert.rejects(startHttpExampleServer(createServer(Board), { documentId, saveServerCheckpoint() { invalidSaves++; } }), /Invalid document ID/);
    }
    assert.equal(invalidSaves, 0);
  });

  it("preserves pending and storage when the same origin is replaced by another guarded document", async (t) => {
    const old = await host(t);
    const storage = memory();
    const original = await recovery.connectPersistentBrowserClient(old.url, { storage, fetch });
    mixed(original.doc);
    mixed(original.doc);
    const saved = original.doc.checkpoint();
    await old.close();
    const next = await host(t, Number(new URL(old.url).port));
    assert.equal(next.url, old.url);
    assert.notEqual(next.documentId, original.documentId);
    for (const action of ["sync", "rejectPending"] as const) {
      let posts = 0;
      const restored = await recovery.connectPersistentBrowserClient(next.url, { storage, fetch: async (input, init) => {
        if (init?.method === "POST" && !(input instanceof Request ? input.url : input.toString()).endsWith("/clients")) posts++;
        return fetch(input, init);
      } });
      const message = storage.getItem(key);
      let failure: unknown;
      await assert.rejects(restored[action](), (error: unknown) => { failure = error; return error instanceof Error && /lineage mismatch/.test(error.message); });
      await assert.rejects(restored.sync(), (error: unknown) => error === failure);
      assert.deepEqual(restored.doc.checkpoint(), saved);
      assert.equal(restored.doc.state.body.toString(), "Hi😀Hi😀");
      assert.equal(storage.getItem(key), message);
      assert.equal(posts, 0);
    }
    assert.equal(next.server.snapshot().serverSeq, 0);
    assert.equal(next.resolves(), 0);
    assert.equal(next.saves(), 1);
  });

  it("rejects missing, invalid and changed response IDs before snapshot, catch-up or acknowledgement", async (t) => {
    for (const stage of ["registration", "catch-up", "POST"] as const) {
      for (const replacement of [null, "invalid", crypto.randomUUID()]) {
        const h = await host(t);
        const storage = memory();
        let posts = 0;
        let badResponse: Response | undefined;
        const injected: typeof fetch = async (input, init) => {
          const response = await fetch(input, init);
          if (init?.method === "POST" && !(input instanceof Request ? input.url : input.toString()).endsWith("/clients")) posts++;
          const path = new URL((input instanceof Request ? input.url : input.toString())).pathname;
          if ((stage === "registration" && path === "/clients") || (stage === "catch-up" && path === "/commits") ||
            (stage === "POST" && init?.method === "POST" && !(input instanceof Request ? input.url : input.toString()).endsWith("/clients"))) {
            const headers = new Headers(response.headers);
            if (replacement === null) headers.delete(header); else headers.set(header, replacement);
            return badResponse = new Response(response.body, { status: response.status, headers });
          }
          return response;
        };
        if (stage === "registration") {
          if (replacement === null || replacement === "invalid") {
            await assert.rejects(recovery.connectPersistentBrowserClient(h.url, { storage, fetch: injected }), /lineage mismatch/);
            assert.equal(storage.getItem(key), null);
          } else {
            // No previous identity exists: a valid first snapshot ID establishes trust.
            const a = await recovery.connectPersistentBrowserClient(h.url, { storage, fetch: injected });
            assert.equal(a.documentId, replacement);
            mixed(a.doc);
            const message = storage.getItem(key);
            await assert.rejects(a.sync(), /lineage mismatch/);
            assert.equal(storage.getItem(key), message);
            assert.equal(a.doc.checkpoint().pendingBatches.length, 1);
          }
        } else {
          const a = await recovery.connectPersistentBrowserClient(h.url, { storage, fetch: injected });
          mixed(a.doc); mixed(a.doc);
          const saved = a.doc.checkpoint();
          const message = storage.getItem(key);
          if (stage === "catch-up") h.server.receive({ clientId: h.server.openClient(), seq: 1, operations: [{ type: "value/set", path: "count", value: 99 }] });
          await assert.rejects(a.sync(), /lineage mismatch/);
          await assert.rejects(a.rejectPending(), /lineage mismatch/);
          assert.deepEqual(a.doc.checkpoint(), saved);
          assert.equal(storage.getItem(key), message);
        }
        assert.equal(posts, stage === "POST" ? 1 : 0);
        assert.equal(h.resolves(), stage === "registration" ? 0 : 1); // Catch-up peer or accepted-but-unacknowledged POST.
        assert.ok(badResponse !== undefined);
        assert.ok(badResponse.body === null || badResponse.bodyUsed); // The rejected response cannot leak its body.
      }
    }
  });

  it("rejects legacy or malformed envelopes without overwriting either store", async (t) => {
    const path = directory(t);
    const store = createCheckpointStore(path);
    const h = await host(t);
    const storage = memory();
    const a = await recovery.connectPersistentBrowserClient(h.url, { storage, fetch });
    mixed(a.doc);
    const client = { documentId: h.documentId, checkpoint: a.doc.checkpoint() };
    const server = { documentId: h.documentId, checkpoint: h.server.checkpoint() };
    for (const record of [client, server]) {
      for (const input of [record.checkpoint, { checkpoint: record.checkpoint }, { ...record, extra: true },
        { ...record, documentId: "invalid" }, { ...record, checkpoint: {} }, null, []]) {
        const message = JSON.stringify(input);
        if (record === client) {
          storage.setItem(key, message);
          await assert.rejects(recovery.connectPersistentBrowserClient(h.url, { storage, fetch: async () => { throw new Error("Unexpected request"); } }));
          assert.equal(storage.getItem(key), message);
        } else {
          writeFileSync(join(path, "server.json"), message);
          await assert.rejects(startBrowserReloadRecoveryServer({ directory: path }));
          assert.equal(readFileSync(join(path, "server.json"), "utf8"), message);
        }
      }
    }
    store.saveRecoveryServer(server);
    const loaded = store.loadRecoveryServer()!;
    assert.ok(Object.isFrozen(loaded));
    assert.ok(Object.isFrozen(loaded.checkpoint));
    assert.deepEqual(loaded, server);
    storage.setItem(key, JSON.stringify(client));
    const decoded = recovery.createSessionCheckpointStore(storage).load()!;
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.checkpoint.pendingBatches));
    assert.deepEqual(decoded, client);
  });

  it("keeps identity stable through persistent restart and catch-up of a saved lost acknowledgement", async (t) => {
    const path = directory(t);
    const store = createCheckpointStore(path);
    let http = await startBrowserReloadRecoveryServer({ directory: path });
    t.after(() => http.close());
    const origin = http.url;
    const storage = memory();
    const failure = new Error("Lost response");
    const a = await recovery.connectPersistentBrowserClient(origin, { storage, fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === "POST" && !(input instanceof Request ? input.url : input.toString()).endsWith("/clients")) { await response.text(); throw failure; }
      return response;
    } });
    mixed(a.doc); mixed(a.doc);
    await assert.rejects(a.sync(), (error: unknown) => error === failure);
    const saved = store.loadRecoveryServer()!;
    assert.equal(saved.documentId, a.documentId);
    assert.equal(saved.checkpoint.snapshot.serverSeq, 1);
    await http.close();
    http = await startBrowserReloadRecoveryServer({ directory: path, port: Number(new URL(origin).port) });
    const posts: number[] = [];
    const b = await recovery.connectPersistentBrowserClient(origin, { storage, fetch: async (input, init) => {
      if (init?.method === "POST" && !(input instanceof Request ? input.url : input.toString()).endsWith("/clients")) posts.push(decodeClientBatch(Board, JSON.parse(typeof init.body === "string" ? init.body : assert.fail("Expected JSON request body"))).seq);
      return fetch(input, init);
    } });
    assert.equal(b.documentId, a.documentId);
    assert.equal(await b.sync(), true);
    assert.deepEqual(posts, [2]);
    assert.equal(store.loadRecoveryServer()!.documentId, a.documentId);
    assert.equal(saved.checkpoint.snapshot.serverSeq, 1); // Point-in-time record.
    assert.deepEqual(store.loadRecoveryServer()!.checkpoint.snapshot, b.doc.checkpoint().snapshot);
  });

  it("preserves the first local save error when an in-flight response later mismatches", async (t) => {
    const h = await host(t);
    const storage = memory();
    const failure = new Error("Storage failed first");
    let fail = false;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const a = await recovery.connectPersistentBrowserClient(h.url, { storage: {
      getItem: storage.getItem, setItem(name, value) { if (fail) throw failure; storage.setItem(name, value); },
    }, fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL((input instanceof Request ? input.url : input.toString())).pathname === "/commits") {
        reached(); await gate;
        const headers = new Headers(response.headers); headers.delete(header);
        return new Response(response.body, { status: response.status, headers });
      }
      return response;
    } });
    mixed(a.doc);
    const message = storage.getItem(key);
    const syncing = a.sync();
    const rejected = assert.rejects(syncing, (error: unknown) => error === failure);
    try {
      await ready;
      fail = true;
      assert.throws(() => mixed(a.doc), (error: unknown) => error === failure);
    } finally { release(); }
    await rejected;
    await assert.rejects(a.rejectPending(), (error: unknown) => error === failure);
    assert.equal(storage.getItem(key), message);
    assert.equal(h.server.snapshot().serverSeq, 0);
  });
});
