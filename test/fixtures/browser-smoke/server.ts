import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createBrowserAssetHandler } from "../../../examples/shared/assets.ts";

/** Example-only asset host. The collaborative server itself runs in the browser. */
export async function startBrowserSmokeServer() {
  const directory = import.meta.dirname;
  const serveAsset = createBrowserAssetHandler(new Map([
    ["/", { file: join(directory, "index.html"), type: "text/html; charset=utf-8" }],
    ["/smoke.js", { file: join(directory, "smoke.js"), type: "text/javascript; charset=utf-8" }],
  ]));
  const http = createServer((request, response) => {
    if (serveAsset(request, response)) return;
    request.resume();
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("Unknown asset");
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => { http.off("error", reject); resolve(); });
  });
  const address = http.address();
  if (address === null || typeof address === "string") {
    http.close();
    throw new Error("Expected a localhost TCP address");
  }
  let closing: Promise<void> | undefined;
  return {
    url: "http://127.0.0.1:" + address.port,
    close(): Promise<void> {
      return closing ??= new Promise<void>((resolve, reject) => {
        http.close((error) => { if (error) reject(error); else resolve(); });
        http.closeAllConnections();
      });
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = await startBrowserSmokeServer();
  console.log("Open " + host.url + " in your browser. Press Ctrl+C to close.");
  function stop(): void {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void host.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
