import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { createServer, type ServerDocument } from "articollab";
import { createSyncHandler } from "articollab/sync";
import { keepSafeLinks, Note } from "./schema.js";
import { createBrowserAssetHandler } from "../shared/assets.ts";
import { toNodeListener } from "../shared/fetch-bridge.ts";
import { selectionSchema } from "../shared/presence.js";

/**
 * Localhost host: the sync handler with presence, as WebSocket /sync/socket and as HTTP routes under
 * /sync/, plus the page's own modules. React and Tiptap load from esm.sh. The server keeps only
 * http: and https: links.
 */
export async function startTiptapServer(
  server: ServerDocument<typeof Note.definition> = createServer(Note, { resolve: keepSafeLinks }), presenceTtl = 30_000
) {
  const directory = import.meta.dirname;
  const javascript = "text/javascript; charset=utf-8";
  const entries = new Map([
    ["/", { file: join(directory, "index.html"), type: "text/html; charset=utf-8" }],
    ["/shared/sync-ui.js", { file: join(directory, "../shared/sync-ui.js"), type: javascript }],
    ["/shared/presence.js", { file: join(directory, "../shared/presence.js"), type: javascript }],
  ]);
  for (const name of ["page", "app", "schema"]) {
    entries.set(`/tiptap-react/${name}.js`, { file: join(directory, `${name}.js`), type: javascript });
  }
  const assets = createBrowserAssetHandler(entries);
  // Rejections let a blocked writer discard its pending work.
  const handle = createSyncHandler(Note, server, {
    allowRejections: true, presence: { schema: selectionSchema, ttl: presenceTtl },
  });
  const sync = toNodeListener(handle);
  const sockets = new WebSocketServer({ noServer: true });

  const http = createHttpServer((request, response) => {
    const path = (request.url ?? "/").split("?", 1)[0]!;
    if (path.startsWith("/sync/")) { sync(request, response); return; }
    if (assets(request, response)) return;
    request.resume();
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Unknown route" }));
  });
  http.on("upgrade", (incoming, socket, head) => {
    if ((incoming.url ?? "/").split("?", 1)[0] !== "/sync/socket") { socket.destroy(); return; }
    sockets.handleUpgrade(incoming, socket, head, (ws) => {
      const connection = handle.accept(ws, new Request(new URL(incoming.url ?? "/", "http://127.0.0.1")));
      ws.on("message", (data) => { connection.message(Array.isArray(data) ? Buffer.concat(data) : data); });
      ws.on("close", () => { connection.close(); });
    });
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
        http.closeAllConnections();
        for (const ws of sockets.clients) ws.terminate();
        sockets.close();
      });
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = await startTiptapServer();
  console.log("Open " + host.url + " in your browser. Press Ctrl+C to close.");
  function stop(): void {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void host.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
