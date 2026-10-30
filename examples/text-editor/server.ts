import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "../../src/index.ts";
import { Board } from "../resume.ts";
import { startHttpExampleServer } from "../http-sync.ts";
import { createBrowserAssetHandler } from "../browser-smoke/server.ts";
import { createPresenceRelay } from "./presence-relay.ts";

/** CodeMirror is local to this example. Only these exact ESM files are served. */
export async function startTextEditorServer(server = createServer(Board), presence = createPresenceRelay()) {
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
    ["/http-sync-controller.js", { file: join(directory, "../http-sync-controller.js"), type: "text/javascript; charset=utf-8" }],
  ]);
  for (const name of ["page", "editor", "binding", "changes", "actions", "presence"]) {
    entries.set(`/text-editor/${name}.js`, { file: join(directory, `${name}.js`), type: "text/javascript; charset=utf-8" });
  }
  for (const [name, file] of modules) entries.set(`/codemirror/${name}.js`, { file, type: "text/javascript; charset=utf-8" });
  const assets = createBrowserAssetHandler(entries);
  // Routes the core host does not own: the in-memory presence relay first, then fixed assets.
  return startHttpExampleServer(server, { serveAsset: (request, response) => presence.handle(request, response) || assets(request, response) });
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
