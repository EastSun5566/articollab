import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createServer } from "../../src/index.ts";
import { createBrowserAssetHandler } from "../browser-smoke/server.ts";
import { startHttpExampleServer } from "../http-sync.ts";
import { Board } from "../resume.ts";

/** Two browser clients communicate only over HTTP with this authoritative server. */
export async function startBrowserHttpSmokeServer() {
  const directory = import.meta.dirname;
  const serveAsset = createBrowserAssetHandler(new Map([
    ["/", { file: join(directory, "index.html"), type: "text/html; charset=utf-8" }],
    ["/browser-http-smoke/smoke.js", { file: join(directory, "smoke.js"), type: "text/javascript; charset=utf-8" }],
    ["/http-sync-controller.js", { file: join(directory, "../http-sync-controller.js"), type: "text/javascript; charset=utf-8" }],
  ]));
  const server = createServer(Board, {
    resolve: ({ batch }) => batch.clientId.startsWith("reject-") && batch.seq === 1 ? [] : batch.operations,
  });
  return startHttpExampleServer(server, { serveAsset });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = await startBrowserHttpSmokeServer();
  console.log("Open " + host.url + " in Chrome. Press Ctrl+C to close.");
  function stop(): void {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void host.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
