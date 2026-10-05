import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startBrowserSmokeServer } from "../examples/browser-smoke/server.ts";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const smokeUrl = new URL("../examples/browser-smoke/smoke.js", import.meta.url).href;
const serverUrl = new URL("../examples/browser-smoke/server.ts", import.meta.url).href;
let smoke: { runBrowserSmoke(): Array<{ name: string; stages: unknown[] }> };

async function host(t: TestContext) {
  const result = await startBrowserSmokeServer();
  t.after(() => result.close());
  return result;
}

describe("browser core smoke example", { timeout: 30_000 }, () => {
  before(async () => {
    // Build once before the dynamic import so pnpm test also works without an existing dist.
    const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
    await execute(process.execPath, [compiler, "-p", "tsconfig.build.json"], { cwd: root, timeout: 15_000 });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deferred import of repository-owned JS after build; its interface is independently JSDoc-checked.
    smoke = (await import(smokeUrl)) as typeof smoke;
  });

  it("checks optimistic delivery, JSON restore and blocked recovery through built ESM", () => {
    const reports = smoke.runBrowserSmoke();
    assert.deepEqual(reports.map((report) => report.name), ["Optimistic edits and delayed delivery",
      "JSON checkpoint restore", "Rejection and blocked recovery"]);
    for (const report of reports) assert.ok(report.stages.length >= 3);
  });

  it("produces the same stages and results on each fresh run", () => {
    assert.deepEqual(smoke.runBrowserSmoke(), smoke.runBrowserSmoke());
  });

  it("serves local ESM bytes, MIME types and extensionless dependency aliases", async (t) => {
    const { url } = await host(t);
    const articulated = require.resolve("articulated/package.json");
    const sparse = createRequire(articulated).resolve("sparse-array-rled/package.json");
    const cases = [
      ["/", join(root, "examples/browser-smoke/index.html"), "text/html"],
      ["/smoke.js", join(root, "examples/browser-smoke/smoke.js"), "text/javascript"],
      ["/dist/index.js", join(root, "dist/index.js"), "text/javascript"],
      ["/vendor/articulated/index.js", join(dirname(articulated), "build/esm/index.js"), "text/javascript"],
      ["/vendor/articulated/id_list", join(dirname(articulated), "build/esm/id_list.js"), "text/javascript"],
      ["/vendor/articulated/id_list.js", join(dirname(articulated), "build/esm/id_list.js"), "text/javascript"],
      ["/vendor/articulated/internal/leaf_map", join(dirname(articulated), "build/esm/internal/leaf_map.js"), "text/javascript"],
      ["/vendor/sparse-array-rled/index.js", join(dirname(sparse), "build/esm/index.js"), "text/javascript"],
      ["/vendor/sparse-array-rled/sparse_indices", join(dirname(sparse), "build/esm/sparse_indices.js"), "text/javascript"],
    ] as const;
    for (const [route, file, type] of cases) {
      const response = await fetch(url + route);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get("Content-Type"), type + "; charset=utf-8");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(await response.text(), readFileSync(file, "utf8"));
    }
    const html = readFileSync(cases[0][1], "utf8");
    const map = html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/);
    assert.ok(map);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Known JSON fixture is made mutable to verify ownership or inject corruption; production decoders are tested separately.
    assert.deepEqual((JSON.parse(map[1]!) as { imports: unknown }).imports, { articollab: "/dist/index.js",
      articulated: "/vendor/articulated/index.js", "sparse-array-rled": "/vendor/sparse-array-rled/index.js" });
    assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'));
  });

  it("rejects unknown and private assets and wrong methods without stopping the host", async (t) => {
    const { url } = await host(t);
    for (const path of ["/unknown", "/src/index.ts", "/package.json", "/dist/index.d.ts",
      "/dist/index.js.map", "/vendor/articulated/package.json", "/vendor/articulated/%2e%2e%2fpackage.json"]) {
      const response = await fetch(url + path);
      assert.equal(response.status, 404, path);
      assert.equal(await response.text(), "Unknown asset");
    }
    const wrong = await fetch(url + "/smoke.js", { method: "POST", body: "ignored" });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("Allow"), "GET");
    assert.equal(await wrong.text(), "Method not allowed");
    const next = await fetch(url + "/smoke.js");
    assert.equal(next.status, 200);
    await next.text();
  });

  it("imports without sockets, smoke execution, DOM access or demo output", async () => {
    const builtUrl = new URL("../dist/index.js", import.meta.url).href;
    const code = `
      const { ClientDocument } = await import(${JSON.stringify(builtUrl)});
      ClientDocument.prototype.transact = () => { throw new Error("Unexpected smoke execution"); };
      Object.defineProperty(globalThis, "document", { get() { throw new Error("Unexpected DOM access"); } });
      await import(${JSON.stringify(serverUrl)});
      await import(${JSON.stringify(smokeUrl)});
    `;
    const result = await execute(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", code],
      { cwd: root, timeout: 10_000 });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});
