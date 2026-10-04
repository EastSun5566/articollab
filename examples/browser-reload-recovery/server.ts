import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createServer } from "../../src/index.ts";
import { createBrowserAssetHandler } from "../browser-smoke/server.ts";
import { startHttpExampleServer } from "../http-sync.ts";
import { createCheckpointStore } from "../persistent-resume.ts";
import { Board } from "../resume.ts";

/** Accept-only host; a checkpoint directory and stable port also permit server restart. */
export async function startBrowserReloadRecoveryServer(options: {
  readonly directory?: string;
  readonly port?: number;
} = {}) {
  const directory = import.meta.dirname;
  const serveAsset = createBrowserAssetHandler(new Map([
    ["/", { file: join(directory, "index.html"), type: "text/html; charset=utf-8" }],
    ["/browser-reload-recovery/recovery.js", { file: join(directory, "recovery.js"), type: "text/javascript; charset=utf-8" }],
    ["/browser-http-smoke/smoke.js", { file: join(directory, "../browser-http-smoke/smoke.js"), type: "text/javascript; charset=utf-8" }],
    ["/http-sync-controller.js", { file: join(directory, "../http-sync-controller.js"), type: "text/javascript; charset=utf-8" }],
  ]));
  const store = options.directory === undefined ? undefined : createCheckpointStore(options.directory);
  const checkpoint = store?.loadServer() ?? null;
  const server = createServer(Board, checkpoint === null ? {} : { checkpoint });
  return startHttpExampleServer(server, { serveAsset,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(store === undefined ? {} : { saveServerCheckpoint: store.saveServer }),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || !/^[1-9]\d*$/.test(args[1]!) || Number(args[1]) > 65535)) {
    throw new Error("Usage: node examples/browser-reload-recovery/server.ts [<existing-directory> <port:1-65535>]");
  }
  const host = await startBrowserReloadRecoveryServer(args.length === 0 ? {} : { directory: args[0]!, port: Number(args[1]) });
  console.log("Open " + host.url + " in Chrome. " + (args.length === 0
    ? "In-memory mode: keep this server running across reloads."
    : "Persistent mode: restart with the same directory and port, then reload the same tab.") + " Press Ctrl+C to close.");
  function stop(): void {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void host.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
