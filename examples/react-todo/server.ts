import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type ServerDocument } from "articollab";
import { createSyncHandler } from "articollab/sync";
import { createBrowserAssetHandler } from "../shared/assets.ts";
import { toNodeListener } from "../shared/fetch-bridge.ts";
import { editingSchema, Todos, type Shape } from "./schema.js";

/** Example-only localhost host: the sync handler with presence under /sync/, and the page's assets. */
export async function startTodoServer(server: ServerDocument<Shape> = createServer(Todos)) {
  const directory = import.meta.dirname;
  const javascript = "text/javascript; charset=utf-8";
  const assets = createBrowserAssetHandler(new Map([
    ["/", { file: join(directory, "index.html"), type: "text/html; charset=utf-8" }],
    ["/shared/sync-ui.js", { file: join(directory, "../shared/sync-ui.js"), type: javascript }],
    ...["page", "app", "schema"].map((name) => [`/react-todo/${name}.js`, { file: join(directory, `${name}.js`), type: javascript }] as const),
  ]));
  const sync = toNodeListener(createSyncHandler(Todos, server, { presence: { schema: editingSchema } }));
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
  const host = await startTodoServer();
  console.log("Open " + host.url + " in your browser. Press Ctrl+C to close.");
  function stop(): void {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void host.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
