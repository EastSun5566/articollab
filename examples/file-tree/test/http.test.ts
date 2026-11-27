import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { IDBFactory } from "fake-indexeddb";
import { createClient } from "articollab";
import { connectSync, createHttpTransport, openIndexedDbStore } from "articollab/sync";
import { createOfflineSwitch } from "../../shared/sync-ui.js";
import { selectionSchema } from "../presence.js";
import { createTreeServer, SEED, startTreeServer } from "../server.ts";
import { childrenOf, createNode, describeTransform, moveNode, pathOf, ROOT, Tree, type TreeDocument } from "../tree.js";

/** Waits for `condition` with real timers: writers synchronize on their own. */
async function until(condition: () => boolean, what: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const paths = (doc: TreeDocument) => [...doc.state.parents.keys()].map((id) => pathOf(doc, id) ?? "").toSorted((x, y) => x.localeCompare(y));

async function fixture(t: TestContext) {
  const server = createTreeServer();
  const host = await startTreeServer(server);
  const stops: (() => void)[] = [];
  t.after(async () => { for (const stop of stops) stop(); await host.close(); });
  async function connect(store?: Awaited<ReturnType<typeof openIndexedDbStore>>) {
    const network = createOfflineSwitch();
    const sync = await connectSync(Tree, { pollInterval: 0, retry: { initialDelay: 20, maxDelay: 100 },
      presence: { schema: selectionSchema }, ...(store === undefined ? {} : { store }),
      transport: createHttpTransport({ url: host.url + "/sync/", fetch: network.fetch }) });
    const notices: string[] = [];
    sync.doc.on("transform", (event) => { notices.push(...describeTransform(event, sync.doc)); });
    stops.push(() => { sync.close(); });
    await sync.sync();
    await until(() => sync.push === "open", "the push channel");
    return { sync, network, notices,
      settled: () => sync.doc.checkpoint().pendingBatches.length === 0 && sync.doc.checkpoint().snapshot.serverSeq === server.snapshot().serverSeq };
  }
  return { host, server, connect };
}

describe("Folder tree over HTTP", { timeout: 30_000 }, () => {
  it("converges both writers on their own and keeps the tree acyclic", async (t) => {
    const f = await fixture(t), a = await f.connect(), b = await f.connect();
    assert.equal(a.sync.doc.state.parents.size, SEED.length);
    a.network.set(true);
    assert.ok(moveNode(a.sync.doc, "seed-docs", "seed-src")); // Offline: waits.
    assert.ok(moveNode(b.sync.doc, "seed-src", "seed-docs"));
    await until(() => b.settled(), "B's move");
    a.network.set(false);
    await a.sync.sync();
    await until(() => a.settled() && b.settled() && a.notices.length === 1, "A's move to be refused");
    assert.deepEqual(a.notices, ["Not moved: “docs”. A folder cannot go inside itself."]);
    assert.deepEqual(paths(a.sync.doc), paths(b.sync.doc));
    assert.equal(pathOf(a.sync.doc, "seed-src"), "docs/src");
  });

  it("shows each writer which node the other selected", async (t) => {
    const f = await fixture(t), a = await f.connect(), b = await f.connect();
    a.sync.presence.set({ selected: "seed-notes" });
    const aId = a.sync.doc.checkpoint().clientId;
    await until(() => b.sync.presence.peers.get(aId)?.selected === "seed-notes", "A's selection at B");
    a.sync.presence.set({ selected: null });
    await until(() => b.sync.presence.peers.get(aId)?.selected === null, "A's cleared selection");
    const refused = await fetch(f.host.url + "/sync/presence", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: aId, state: { selected: 42 } }) });
    assert.equal(refused.status, 400, "the host checks the selection schema");
  });

  it("keeps unsent edits across a reload in IndexedDB", async (t) => {
    const f = await fixture(t);
    const indexedDB = new IDBFactory();
    const open = () => openIndexedDbStore({ database: "articollab-file-tree", key: "doc:A", slots: 2, indexedDB });
    const before = await f.connect(await open());
    before.network.set(true);
    createNode(before.sync.doc, "seed-docs", "file", "offline.md");
    await until(() => before.sync.status === "retrying", "the offline writer to retry");
    before.sync.close();
    const after = await f.connect(await open());
    assert.equal(after.sync.doc.checkpoint().clientId, before.sync.doc.checkpoint().clientId, "the same writer resumes");
    await until(() => after.settled(), "the restored edit to be sent");
    assert.ok(childrenOf(after.sync.doc, "seed-docs").some((id) => after.sync.doc.state.names.get(id) === "offline.md"));
    assert.ok(Object.values(f.server.snapshot().data.names).includes("offline.md"));
  });

  it("serves fixed ESM assets and the sync routes, and closes idempotently", async (t) => {
    const f = await fixture(t);
    const response = await fetch(f.host.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal(html, readFileSync(new URL("../index.html", import.meta.url), "utf8"));
    for (const route of ["/vendor/articulated/index.js", "/dist/index.js", "/dist/sync/index.js", "/file-tree/page.js",
      "/file-tree/tree.js", "/file-tree/presence.js", "/shared/sync-ui.js", "/shared/writer-store.js"]) {
      const asset = await fetch(f.host.url + route);
      assert.equal(asset.status, 200, route);
      assert.equal(asset.headers.get("Content-Type"), "text/javascript; charset=utf-8");
      assert.ok((await asset.text()).length > 0);
    }
    for (const route of ["/server.ts", "/file-tree/policy.ts", "/file-tree/server.ts", "/package.json", "/src/index.ts", "/sync/unknown"]) {
      const asset = await fetch(f.host.url + route); assert.equal(asset.status, 404, route); await asset.text();
    }
    const document = await fetch(f.host.url + "/document");
    assert.equal(document.status, 200);
    const body: unknown = await document.json();
    assert.ok(typeof body === "object" && body !== null && "documentId" in body && typeof body.documentId === "string");
    assert.equal(childrenOf(serverTree(f.server), ROOT).length, 3);
    await f.host.close(); await f.host.close();
  });

  it("imports without DOM, fetch, registration or listening side effects", async () => {
    const modules = ["server.ts", "page.js", "tree.js", "policy.ts", "presence.js", "../shared/writer-store.js"];
    const script = `
      const { Server } = await import("node:http");
      Server.prototype.listen = () => { throw new Error("Unexpected listen"); };
      globalThis.fetch = () => { throw new Error("Unexpected fetch"); };
      Object.defineProperty(globalThis, "document", { get() { throw new Error("Unexpected DOM access"); } });
      for (const url of ${JSON.stringify(modules.map((name) => new URL("../" + name, import.meta.url).href))}) await import(url);
    `;
    const result = await promisify(execFile)(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", script], { timeout: 10_000 });
    assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  });
});

/** A read-only view of the server's tree. */
function serverTree(server: ReturnType<typeof createTreeServer>): TreeDocument {
  return createClient(Tree, { clientId: server.openClient(), snapshot: server.snapshot(), onBatch() {} });
}
