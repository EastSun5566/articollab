import { readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Serves fixed routes plus the built package and its dependencies; never a path from the request. */
export function createBrowserAssetHandler(entries: ReadonlyMap<string, { file: string; type: string }>) {
  const entrypoint = import.meta.resolve("articollab");
  const require = createRequire(entrypoint);
  const articulatedPackage = require.resolve("articulated/package.json");
  const sparsePackage = createRequire(articulatedPackage).resolve("sparse-array-rled/package.json");
  const assets = new Map(entries);

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
    addModules(dirname(fileURLToPath(entrypoint)), "/dist");
    addModules(join(dirname(articulatedPackage), "build/esm"), "/vendor/articulated", true);
    addModules(join(dirname(sparsePackage), "build/esm"), "/vendor/sparse-array-rled", true);
    for (const route of [...entries.keys(), "/dist/index.js", "/vendor/articulated/index.js", "/vendor/sparse-array-rled/index.js"]) {
      const asset = assets.get(route);
      if (asset === undefined) throw new Error("Missing entrypoint: " + route);
      readFileSync(asset.file);
    }
  } catch (cause) {
    throw new Error("Browser assets are unavailable; run pnpm build and check installed dependencies", { cause });
  }

  return (request: IncomingMessage, response: ServerResponse): boolean => {
    // Look up a fixed route, never resolve a filesystem path supplied by the request.
    const asset = assets.get((request.url ?? "/").split("?", 1)[0]!);
    if (asset === undefined) return false;
    request.resume();
    function error(status: number, message: string): void {
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(message);
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      error(405, "Method not allowed");
      return true;
    }
    try {
      const content = readFileSync(asset.file);
      response.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(content);
    } catch {
      error(500, "Unable to read browser asset");
    }
    return true;
  };
}
