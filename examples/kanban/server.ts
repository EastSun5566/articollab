import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, createServer, type ServerDocument } from "../../dist/index.js";
import { createSyncHandler } from "../../dist/sync/index.js";
import { createBrowserAssetHandler } from "../browser-smoke/server.ts";
import { toNodeListener } from "../fetch-bridge.ts";
import { addCard, Board, type Column, type Shape } from "./board.js";
import { resolveBoard } from "./policy.ts";

export const SEED_CARDS: readonly { id: string; column: Column; title: string }[] = [
  { id: "seed-sketch", column: "todo", title: "Sketch the release notes" },
  { id: "seed-tests", column: "todo", title: "Write resolver tests" },
  { id: "seed-drag", column: "doing", title: "Drag cards between columns" },
  { id: "seed-ship", column: "done", title: "Ship articollab 0.7" },
];

/** An authoritative board with the example move policy and a few cards, written by an ordinary writer session. */
export function createBoardServer(cards = SEED_CARDS): ServerDocument<Shape> {
  const server = createServer(Board, { resolve: resolveBoard });
  const clientId = server.openClient();
  const doc = createClient(Board, { clientId, snapshot: server.snapshot(),
    onBatch(batch) { doc.receive(server.receive(batch).commit); } });
  for (const card of cards) addCard(doc, card.column, card.title, card.id);
  assert.equal(doc.checkpoint().pendingBatches.length, 0);
  server.closeClient(clientId);
  return server;
}

/** Example-only localhost host: the packaged sync handler under /sync/ and fixed ESM assets. */
export async function startKanbanServer(server = createBoardServer()) {
  const directory = import.meta.dirname;
  const assets = createBrowserAssetHandler(new Map([
    ["/", { file: join(directory, "index.html"), type: "text/html; charset=utf-8" }],
    ["/sync-ui.js", { file: join(directory, "../sync-ui.js"), type: "text/javascript; charset=utf-8" }],
    ...["page", "view", "board"].map((name) => [`/kanban/${name}.js`,
      { file: join(directory, `${name}.js`), type: "text/javascript; charset=utf-8" }] as const),
  ]));
  // Rejections let a writer discard pending work that the server can no longer apply.
  const sync = toNodeListener(createSyncHandler(Board, server, { allowRejections: true }));

  const http = createHttpServer((request, response) => {
    const path = (request.url ?? "/").split("?", 1)[0]!;
    if (path.startsWith("/sync/")) { sync(request, response); return; }
    if (assets(request, response)) return;
    request.resume();
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Unknown route" }));
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => { http.off("error", reject); resolve(); });
  });
  const address = http.address();
  assert.ok(address !== null && typeof address !== "string");
  let closing: Promise<void> | undefined;
  return {
    url: "http://127.0.0.1:" + address.port,
    close(): Promise<void> {
      return closing ??= new Promise<void>((resolve, reject) => {
        http.close((error) => { if (error) reject(error); else resolve(); });
        http.closeAllConnections(); // Event streams never end on their own.
      });
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = await startKanbanServer();
  console.log("Open " + host.url + " in your browser. Press Ctrl+C to close.");
  function stop(): void {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void host.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
