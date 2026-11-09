import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, type ServerDocument } from "../../src/index.ts";
import { createSyncHandler } from "../../src/sync/index.ts";
import { Board } from "../resume.ts";
import { createBrowserAssetHandler } from "../browser-smoke/server.ts";
import { toNodeListener } from "../fetch-bridge.ts";
import { createPresenceRelay } from "./presence-relay.ts";

/**
 * Example-only localhost host: the packaged sync handler under /sync/, the in-memory presence relay
 * and fixed ESM assets. CodeMirror is local to this example; only these exact files are served.
 */
export async function startTextEditorServer(
  server: ServerDocument<typeof Board.definition> = createServer(Board), presence = createPresenceRelay()
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
    ["/browser-http-smoke/smoke.js", { file: join(directory, "../browser-http-smoke/smoke.js"), type: "text/javascript; charset=utf-8" }],
    // smoke.js, which defines the shared Board, imports the controller; the editor itself does not use it.
    ["/http-sync-controller.js", { file: join(directory, "../http-sync-controller.js"), type: "text/javascript; charset=utf-8" }],
  ]);
  for (const name of ["page", "editor", "binding", "changes", "presence"]) {
    entries.set(`/text-editor/${name}.js`, { file: join(directory, `${name}.js`), type: "text/javascript; charset=utf-8" });
  }
  for (const [name, file] of modules) entries.set(`/codemirror/${name}.js`, { file, type: "text/javascript; charset=utf-8" });
  const assets = createBrowserAssetHandler(entries);
  // Rejections let a writer discard pending work that the server's policy blocked.
  const sync = toNodeListener(createSyncHandler(Board, server, { allowRejections: true }));

  const http = createHttpServer((request, response) => {
    const path = (request.url ?? "/").split("?", 1)[0]!;
    if (path.startsWith("/sync/")) { sync(request, response); return; }
    if (presence.handle(request, response) || assets(request, response)) return;
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
