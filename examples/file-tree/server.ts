import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, createServer, type ServerDocument } from "../../dist/index.js";
import { createSyncHandler } from "../../dist/sync/index.js";
import { createBrowserAssetHandler } from "../shared/assets.ts";
import { toNodeListener } from "../shared/fetch-bridge.ts";
import { resolveTree } from "./policy.ts";
import { selectionSchema } from "./presence.js";
import { createNode, ROOT, Tree, type Kind, type Shape } from "./tree.js";

export const SEED: readonly { id: string; parent: string; kind: Kind; name: string }[] = [
  { id: "seed-docs", parent: ROOT, kind: "folder", name: "docs" },
  { id: "seed-notes", parent: "seed-docs", kind: "file", name: "notes.md" },
  { id: "seed-src", parent: ROOT, kind: "folder", name: "src" },
  { id: "seed-index", parent: "seed-src", kind: "file", name: "index.ts" },
  { id: "seed-readme", parent: ROOT, kind: "file", name: "README.md" },
];

/** An authoritative tree with the example policy and a few nodes, written by an ordinary writer session. */
export function createTreeServer(nodes = SEED): ServerDocument<Shape> {
  const server = createServer(Tree, { resolve: resolveTree });
  const clientId = server.openClient();
  const doc = createClient(Tree, { clientId, snapshot: server.snapshot(),
    onBatch(batch) { doc.receive(server.receive(batch).commit); } });
  for (const node of nodes) createNode(doc, node.parent, node.kind, node.name, node.id);
  assert.equal(doc.checkpoint().pendingBatches.length, 0);
  server.closeClient(clientId);
  return server;
}

/** Localhost host: the sync handler with presence under /sync/, a document ID and the page's fixed assets. */
export async function startTreeServer(server = createTreeServer()) {
  const directory = import.meta.dirname;
  const documentId = randomUUID();
  const assets = createBrowserAssetHandler(new Map([
    ["/", { file: join(directory, "index.html"), type: "text/html; charset=utf-8" }],
    ...["sync-ui", "writer-store"].map((name) => [`/shared/${name}.js`,
      { file: join(directory, `../shared/${name}.js`), type: "text/javascript; charset=utf-8" }] as const),
    ...["page", "tree", "presence"].map((name) => [`/file-tree/${name}.js`,
      { file: join(directory, `${name}.js`), type: "text/javascript; charset=utf-8" }] as const),
  ]));
  // Rejections let a blocked writer discard its pending work.
  const sync = toNodeListener(createSyncHandler(Tree, server, { allowRejections: true, presence: { schema: selectionSchema } }));

  const http = createHttpServer((request, response) => {
    const path = (request.url ?? "/").split("?", 1)[0]!;
    if (path.startsWith("/sync/")) { sync(request, response); return; }
    // A new ID per start: pages key saved checkpoints by it, so they never restore one into a new document.
    if (path === "/document" && request.method === "GET") {
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ documentId }));
      return;
    }
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
  const host = await startTreeServer();
  console.log("Open " + host.url + " in your browser. Press Ctrl+C to close.");
  function stop(): void {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void host.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
