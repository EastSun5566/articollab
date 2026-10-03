import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Example-only asset host. The collaborative server itself runs in the browser. */
export async function startBrowserSmokeServer() {
  const directory = import.meta.dirname;
  const require = createRequire(import.meta.url);
  const articulatedPackage = require.resolve("articulated/package.json");
  const sparsePackage = createRequire(articulatedPackage).resolve("sparse-array-rled/package.json");
  const assets = new Map<string, { file: string; type: string }>([
    ["/", { file: join(directory, "index.html"), type: "text/html; charset=utf-8" }],
    ["/smoke.js", { file: join(directory, "smoke.js"), type: "text/javascript; charset=utf-8" }],
  ]);

  function addModules(root: string, prefix: string, extensionless = false): void {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const file = join(root, entry.name);
      const route = prefix + "/" + entry.name;
      if (entry.isDirectory()) addModules(file, route, extensionless);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        const asset = { file, type: "text/javascript; charset=utf-8" };
        assets.set(route, asset);
        // These installed ESM builds use relative imports without file extensions.
        if (extensionless) assets.set(route.slice(0, -3), asset);
      }
    }
  }

  try {
    addModules(join(directory, "../../dist"), "/dist");
    addModules(join(dirname(articulatedPackage), "build/esm"), "/vendor/articulated", true);
    addModules(join(dirname(sparsePackage), "build/esm"), "/vendor/sparse-array-rled", true);
    for (const route of ["/", "/smoke.js", "/dist/index.js", "/vendor/articulated/index.js", "/vendor/sparse-array-rled/index.js"]) {
      const asset = assets.get(route);
      if (asset === undefined) throw new Error("Missing entrypoint: " + route);
      readFileSync(asset.file);
    }
  } catch (cause) {
    throw new Error("Browser assets are unavailable; run pnpm build and check installed dependencies", { cause });
  }

  const http = createServer((request, response) => {
    request.resume();
    // Look up a fixed route, never resolve a filesystem path supplied by the request.
    const asset = assets.get((request.url ?? "/").split("?", 1)[0]!);
    function error(status: number, message: string): void {
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(message);
    }
    if (asset === undefined) { error(404, "Unknown asset"); return; }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      error(405, "Method not allowed");
      return;
    }
    try {
      const content = readFileSync(asset.file);
      response.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(content);
    } catch {
      error(500, "Unable to read browser asset");
    }
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
  console.log("Open " + host.url + " in Chrome. Press Ctrl+C to close.");
  function stop(): void {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void host.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
