import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, type ServerDocument } from "../../dist/index.js";
import { createSyncHandler } from "../../dist/sync/index.js";
import { Note } from "./schema.js";
import { createBrowserAssetHandler } from "../shared/assets.ts";
import { toNodeListener } from "../shared/fetch-bridge.ts";
import { selectionSchema } from "./presence.js";

/** Localhost host: the sync handler with presence under /sync/, plus the page's fixed assets. */
export async function startTextEditorServer(
  server: ServerDocument<typeof Note.definition> = createServer(Note), presenceTtl = 30_000
) {
  const directory = import.meta.dirname;
  const state = fileURLToPath(import.meta.resolve("@codemirror/state"));
  const view = fileURLToPath(import.meta.resolve("@codemirror/view"));
  const stateRequire = createRequire(state), viewRequire = createRequire(view);
  const modules = new Map([
    ["state", state], ["view", view],
    ["find-cluster-break", join(dirname(stateRequire.resolve("@marijn/find-cluster-break")), "../src/index.js")],
    ["crelt", join(dirname(viewRequire.resolve("crelt")), "../index.js")],
    ["style-mod", join(dirname(viewRequire.resolve("style-mod")), "../src/style-mod.js")],
    ["w3c-keyname", join(dirname(viewRequire.resolve("w3c-keyname")), "index.js")],
  ]);
  const entries = new Map([
    ["/", { file: join(directory, "index.html"), type: "text/html; charset=utf-8" }],
    ["/shared/sync-ui.js", { file: join(directory, "../shared/sync-ui.js"), type: "text/javascript; charset=utf-8" }],
  ]);
  for (const name of ["page", "editor", "binding", "changes", "presence", "schema"]) {
    entries.set(`/text-editor/${name}.js`, { file: join(directory, `${name}.js`), type: "text/javascript; charset=utf-8" });
  }
  for (const [name, file] of modules) entries.set(`/codemirror/${name}.js`, { file, type: "text/javascript; charset=utf-8" });
  const assets = createBrowserAssetHandler(entries);
  // Rejections let a blocked writer discard its pending work.
  const sync = toNodeListener(createSyncHandler(Note, server, {
    allowRejections: true, presence: { schema: selectionSchema, ttl: presenceTtl },
  }));

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
  const host = await startTextEditorServer();
  console.log("Open " + host.url + " in your browser. Press Ctrl+C to close.");
  function stop(): void {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void host.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
