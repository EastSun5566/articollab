import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { connectSync, createHttpTransport } from "../../../dist/sync/index.js";
import { createOfflineSwitch } from "../../sync-ui.js";
import { addCard, Board, COLUMNS, deleteCard, findCard, moveCard, renameCard } from "../board.js";
import { createBoardServer, SEED_CARDS, startKanbanServer } from "../server.ts";

/** Waits for `condition` with real timers: writers synchronize on their own. */
async function until(condition: () => boolean, what: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t: TestContext) {
  const server = createBoardServer();
  const host = await startKanbanServer(server);
  const stops: (() => void)[] = [];
  t.after(async () => { for (const stop of stops) stop(); await host.close(); });
  async function connect() {
    const network = createOfflineSwitch();
    const sync = await connectSync(Board, { pollInterval: 0, retry: { initialDelay: 20, maxDelay: 100 },
      transport: createHttpTransport({ url: host.url + "/sync/", fetch: network.fetch }) });
    const discards: string[] = [];
    const stopDiscard = sync.doc.on("discard", ({ operations }) => { for (const { value } of operations) discards.push(value.title); });
    stops.push(() => { stopDiscard(); sync.stop(); });
    await sync.sync();
    await until(() => sync.push === "open", "the push channel");
    return { sync, network, discards,
      board: () => COLUMNS.map((column) => sync.doc.state[column].toArray()),
      settled: () => sync.doc.checkpoint().pendingBatches.length === 0 && sync.doc.checkpoint().snapshot.serverSeq === server.snapshot().serverSeq,
    };
  }
  const serverBoard = () => { const { data } = server.snapshot(); return COLUMNS.map((column) => data[column].values); };
  return { host, server, connect, serverBoard };
}

describe("Kanban board over HTTP", { timeout: 30_000 }, () => {
  it("starts from the seeded cards and converges both writers without explicit syncs", async (t) => {
    const f = await fixture(t), a = await f.connect(), b = await f.connect();
    assert.deepEqual(a.board().flat().map(({ id }) => id), SEED_CARDS.map(({ id }) => id));
    moveCard(a.sync.doc, "seed-drag", "done", 0);
    addCard(b.sync.doc, "doing", "From B", "from-b");
    await until(() => a.settled() && b.settled() && f.server.snapshot().serverSeq === 6, "convergence");
    assert.deepEqual(a.board(), f.serverBoard());
    assert.deepEqual(b.board(), f.serverBoard());
    assert.equal(findCard(b.sync.doc, "seed-drag")?.column, "done");
  });

  it("applies an offline rename to a card another writer moved meanwhile", async (t) => {
    const f = await fixture(t), a = await f.connect(), b = await f.connect();
    a.network.set(true);
    renameCard(a.sync.doc, "seed-tests", "Renamed offline");
    await until(() => a.sync.status === "retrying", "A to notice it is offline");
    moveCard(b.sync.doc, "seed-tests", "done", 1);
    await until(() => b.settled(), "B's move");
    a.network.set(false);
    void a.sync.sync().catch(() => {});
    await until(() => a.settled() && b.settled(), "convergence");
    for (const writer of [a, b]) {
      assert.deepEqual(findCard(writer.sync.doc, "seed-tests"), { column: "done", index: 1, card: { id: "seed-tests", title: "Renamed offline" } });
      assert.deepEqual(writer.board(), f.serverBoard());
    }
    assert.deepEqual(a.discards, []);
  });

  it("reports an offline rename of a card another writer deleted meanwhile", async (t) => {
    const f = await fixture(t), a = await f.connect(), b = await f.connect();
    a.network.set(true);
    renameCard(a.sync.doc, "seed-sketch", "Lost rename");
    deleteCard(b.sync.doc, "seed-sketch");
    await until(() => b.settled(), "B's delete");
    a.network.set(false);
    void a.sync.sync().catch(() => {});
    await until(() => a.settled() && b.settled() && a.discards.length === 1, "the discard");
    assert.deepEqual(a.discards, ["Lost rename"]);
    for (const writer of [a, b]) {
      assert.equal(findCard(writer.sync.doc, "seed-sketch"), undefined);
      assert.deepEqual(writer.board(), f.serverBoard());
    }
  });

  it("serves fixed ESM assets and the sync routes, and closes idempotently", async (t) => {
    const f = await fixture(t);
    const response = await fetch(f.host.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal(html, readFileSync(new URL("../index.html", import.meta.url), "utf8"));
    const match = html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/);
    assert.ok(match);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Parses this example's fixed import map, which is independently checked by fetching every target.
    const map = JSON.parse(match[1]!) as { imports: Record<string, string> };
    for (const route of [...Object.values(map.imports), "/dist/index.js", "/dist/sync/index.js", "/kanban/page.js",
      "/kanban/view.js", "/kanban/board.js", "/sync-ui.js"]) {
      const asset = await fetch(f.host.url + route);
      assert.equal(asset.status, 200, route);
      assert.equal(asset.headers.get("Content-Type"), "text/javascript; charset=utf-8");
      assert.ok((await asset.text()).length > 0);
    }
    for (const route of ["/server.ts", "/kanban/policy.ts", "/kanban/server.ts", "/package.json", "/src/index.ts", "/sync/unknown"]) {
      const asset = await fetch(f.host.url + route); assert.equal(asset.status, 404, route); await asset.text();
    }
    const commits = await fetch(f.host.url + "/sync/commits?since=0");
    assert.equal(commits.status, 200);
    const seeded: unknown = await commits.json();
    assert.ok(Array.isArray(seeded) && seeded.length === SEED_CARDS.length);
    await f.host.close(); await f.host.close();
  });

  it("imports without DOM, fetch, registration or listening side effects", async () => {
    const modules = ["server.ts", "page.js", "view.js", "board.js", "policy.ts", "../sync-ui.js"];
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
