import { decodeSnapshot } from "../src/index.ts";
import { Board } from "../examples/resume.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startBrowserHttpSmokeServer } from "../examples/browser-http-smoke/server.ts";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const smokeUrl = new URL("../examples/browser-http-smoke/smoke.js", import.meta.url).href;
type View = { count: number; items: string[]; body: string; watermark: number; pending: number[]; conflict: unknown };
type Report = { name: string; clientIds: string[]; stages: Array<{
  label: string; server: { serverSeq: number; count: number; items: string[]; body: string }; a: View; b: View;
}> };
let smoke: { runBrowserHttpSmoke(url: string, options?: { fetch: typeof globalThis.fetch }): Promise<Report[]> };

async function host(t: TestContext) {
  const result = await startBrowserHttpSmokeServer();
  t.after(() => result.close());
  return result;
}

function checkReports(reports: Report[]): void {
  assert.deepEqual(reports.map((report) => report.name), ["Mixed optimistic edits and HTTP catch-up",
    "JSON checkpoint restore over HTTP", "HTTP rejection and blocked recovery"]);
  for (const report of reports) {
    assert.ok(report.stages.length >= 3);
    const last = report.stages.at(-1)!;
    for (const client of [last.a, last.b]) {
      assert.deepEqual(client.pending, []);
      assert.equal(client.conflict, null);
      assert.equal(client.watermark, last.server.serverSeq);
      assert.deepEqual({ count: client.count, items: client.items, body: client.body },
        { count: last.server.count, items: last.server.items, body: last.server.body });
    }
  }
}

describe("browser HTTP smoke example", { timeout: 30_000 }, () => {
  before(async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deferred import of repository-owned JS after build; its interface is independently JSDoc-checked.
    smoke = (await import(smokeUrl)) as typeof smoke;
  });

  it("runs three mixed scenarios through HTTP and converges the built clients", async (t) => {
    const { url } = await host(t);
    const reports = await smoke.runBrowserHttpSmoke(url);
    checkReports(reports);
    const initial = reports[0]!.stages[0]!;
    const optimistic = reports[0]!.stages[1]!;
    assert.deepEqual(optimistic.server, initial.server);
    assert.deepEqual(optimistic.a.pending, [1]);
    assert.deepEqual(optimistic.b.pending, [1]);
    const blocked = reports[2]!.stages[1]!;
    assert.deepEqual(blocked.a.pending, [2, 3]);
    assert.ok(blocked.a.conflict);
    const response = await fetch(url + "/snapshot");
    const snapshot = decodeSnapshot(Board, await response.json());
    assert.equal(snapshot.serverSeq, reports[2]!.stages.at(-1)!.server.serverSeq);
  });

  it("reruns against the same live server with fresh writer namespaces", async (t) => {
    const { url } = await host(t);
    const first = await smoke.runBrowserHttpSmoke(url);
    const second = await smoke.runBrowserHttpSmoke(url);
    checkReports(first);
    checkReports(second);
    const oldIds = new Set(first.flatMap((report) => report.clientIds));
    const newIds = second.flatMap((report) => report.clientIds);
    assert.equal(new Set(newIds).size, 6);
    assert.ok(newIds.every((id) => !oldIds.has(id)));
    assert.equal(second[0]!.stages[0]!.server.serverSeq, first[2]!.stages.at(-1)!.server.serverSeq);
    assert.ok(second[2]!.stages.at(-1)!.server.serverSeq > first[2]!.stages.at(-1)!.server.serverSeq);
  });

  it("acknowledges every HTTP POST through catch-up, including explicit rejection", async (t) => {
    const { url } = await host(t);
    const requests: Array<{ path: string; method: string; status: number }> = [];
    checkReports(await smoke.runBrowserHttpSmoke(url, { fetch: async function(this: void, input, init) {
      assert.equal(this, undefined); // Match native browser fetch's receiver contract.
      const response = await fetch(input, init);
      requests.push({ path: new URL((input instanceof Request ? input.url : input.toString())).pathname, method: init?.method ?? "GET", status: response.status });
      return response;
    } }));
    assert.deepEqual(new Set(requests.map((entry) => entry.path)), new Set(["/clients", "/snapshot", "/commits", "/batches", "/rejections"]));
    for (const [index, request] of requests.entries()) {
      if (request.path === "/clients") { assert.equal(request.status, 201); continue; }
      if (request.method !== "POST") continue;
      assert.equal(request.status, 204);
      assert.equal(requests[index + 1]?.path, "/commits");
    }
  });

  it("serves only allowlisted browser modules with correct MIME and keeps APIs available", async (t) => {
    const { url } = await host(t);
    const articulated = require.resolve("articulated/package.json");
    const cases = [
      ["/", join(root, "examples/browser-http-smoke/index.html"), "text/html"],
      ["/browser-http-smoke/smoke.js", join(root, "examples/browser-http-smoke/smoke.js"), "text/javascript"],
      ["/http-sync-controller.js", join(root, "examples/http-sync-controller.js"), "text/javascript"],
      ["/dist/index.js", join(root, "dist/index.js"), "text/javascript"],
      ["/vendor/articulated/id_list", join(dirname(articulated), "build/esm/id_list.js"), "text/javascript"],
    ] as const;
    for (const [route, file, mime] of cases) {
      const response = await fetch(url + route);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Type"), mime + "; charset=utf-8");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(await response.text(), readFileSync(file, "utf8"));
    }
    const html = readFileSync(cases[0][1], "utf8");
    const map = html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/);
    assert.ok(map);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Known JSON fixture is made mutable to verify ownership or inject corruption; production decoders are tested separately.
    assert.deepEqual((JSON.parse(map[1]!) as { imports: unknown }).imports, { articollab: "/dist/index.js",
      articulated: "/vendor/articulated/index.js", "sparse-array-rled": "/vendor/sparse-array-rled/index.js" });
    assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'));
    for (const path of ["/src/index.ts", "/package.json", "/dist/index.d.ts", "/dist/index.js.map",
      "/http-sync-controller.d.ts", "/vendor/articulated/package.json", "/unknown"]) {
      const response = await fetch(url + path);
      assert.equal(response.status, 404, path);
      await response.text();
    }
    const wrong = await fetch(url + "/http-sync-controller.js", { method: "POST", body: "ignored" });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("Allow"), "GET");
    await wrong.text();
    const next = await fetch(url + "/snapshot");
    assert.equal(next.status, 200);
    assert.equal(decodeSnapshot(Board, await next.json()).serverSeq, 0);
  });

  it("propagates the first response failure and does not run later scenarios", async (t) => {
    const { url } = await host(t);
    const failure = new Error("response lost");
    let posts = 0;
    await assert.rejects(smoke.runBrowserHttpSmoke(url, { fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === "POST" && !(input instanceof Request ? input.url : input.toString()).endsWith("/clients")) {
        posts++;
        await response.text();
        throw failure;
      }
      return response;
    } }), (error: unknown) => error === failure);
    assert.equal(posts, 1);
    const response = await fetch(url + "/snapshot");
    assert.equal(decodeSnapshot(Board, await response.json()).serverSeq, 1); // Completed server work is not rolled back.
  });

  it("imports without DOM access, HTTP requests, listening or smoke side effects", async () => {
    const serverUrl = new URL("../examples/browser-http-smoke/server.ts", import.meta.url).href;
    const controllerUrl = new URL("../examples/http-sync-controller.js", import.meta.url).href;
    const code = `
      const { Server } = await import("node:http");
      Server.prototype.listen = () => { throw new Error("Unexpected listen"); };
      globalThis.fetch = () => { throw new Error("Unexpected fetch"); };
      Object.defineProperty(globalThis, "document", { get() { throw new Error("Unexpected DOM access"); } });
      await import(${JSON.stringify(controllerUrl)});
      await import(${JSON.stringify(serverUrl)});
      await import(${JSON.stringify(smokeUrl)});
    `;
    const result = await execute(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", code],
      { cwd: root, timeout: 10_000 });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});
