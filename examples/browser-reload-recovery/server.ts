import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createServer } from "../../src/index.ts";
import { createBrowserAssetHandler } from "../browser-smoke/server.ts";
import { startHttpExampleServer } from "../http-sync.ts";
import { Board } from "../resume.ts";

/** Keep this accept-only server running while reloading the browser page. */
export async function startBrowserReloadRecoveryServer() {
  const directory = import.meta.dirname;
  const serveAsset = createBrowserAssetHandler(new Map([
    ["/", { file: join(directory, "index.html"), type: "text/html; charset=utf-8" }],
    ["/browser-reload-recovery/recovery.js", { file: join(directory, "recovery.js"), type: "text/javascript; charset=utf-8" }],
    ["/browser-http-smoke/smoke.js", { file: join(directory, "../browser-http-smoke/smoke.js"), type: "text/javascript; charset=utf-8" }],
    ["/http-sync-controller.js", { file: join(directory, "../http-sync-controller.js"), type: "text/javascript; charset=utf-8" }],
  ]));
  return startHttpExampleServer(createServer(Board), { serveAsset });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = await startBrowserReloadRecoveryServer();
  console.log("Open " + host.url + " in Chrome; keep this server running across reloads. Press Ctrl+C to close.");
  function stop(): void {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void host.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
