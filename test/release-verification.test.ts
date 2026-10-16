import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { runInNewContext } from "node:vm";

it("bounds registry reads without retrying publication or hiding errors", async () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const match = workflow.match(/- name: Verify registry version, dist-tag and integrity[\s\S]*?<<'NODE'\n([\s\S]*?)\n          NODE/);
  assert.ok(match);
  // Execute the actual workflow block with only its I/O and clock replaced.
  const source = match[1]!.replace(/^ {10}/gm, "").replace(/^import .*;\n/gm, "");
  const version = "0.1.0-beta.1";
  const integrity = "sha512-test";
  const ready = { version, "dist-tags": { beta: version }, dist: { integrity } };
  const missing = Object.assign(new Error("not available"), {
    stdout: JSON.stringify({ error: { code: "E404" } }),
  });

  async function run(responses: readonly (string | Error)[], queryCount: number, waitCount: number) {
    let queries = 0;
    let waits = 0;
    try {
      const execution: unknown = runInNewContext(`(async () => {\n${source}\n})()`, {
        assert,
        process: { env: { NPM_DIST_TAG: "beta", TARBALL_INTEGRITY: integrity } },
        console: { log() {} },
        readFileSync(path: string, encoding: string) {
          assert.equal(path, "package.json");
          assert.equal(encoding, "utf8");
          return JSON.stringify({ name: "articollab", version });
        },
        execFileSync(command: string, args: string[], options: Record<string, unknown>) {
          assert.equal(command, "npm");
          assert.equal(JSON.stringify(args), JSON.stringify([
            "view", `articollab@${version}`, "--json", "--prefer-online", "--registry=https://registry.npmjs.org/",
          ]));
          assert.equal(options.timeout, 15_000);
          const response = responses[queries++];
          assert.notEqual(response, undefined, "Unexpected extra registry read");
          if (response instanceof Error) throw response;
          return response;
        },
        setTimeout(resolve: () => void, milliseconds: number) {
          assert.equal(milliseconds, 15_000);
          waits++;
          resolve();
        },
      });
      await Promise.resolve(execution);
    } finally {
      assert.equal(queries, queryCount);
      assert.equal(waits, waitCount);
    }
  }

  await run([JSON.stringify(ready)], 1, 0);
  await run([missing, JSON.stringify({ ...ready, "dist-tags": { beta: "0.1.0-beta.0" } }), JSON.stringify(ready)], 3, 2);
  // Processing can exceed the old 12-read window, then expose a stale dist-tag first.
  await run([...Array.from({ length: 12 }, () => missing),
    ...Array.from({ length: 8 }, () => JSON.stringify({ ...ready, "dist-tags": { beta: "old" } })),
    JSON.stringify(ready)], 21, 20);
  await run([...Array.from({ length: 23 }, () => missing), JSON.stringify(ready)], 24, 23);
  await assert.rejects(run(Array.from({ length: 24 }, () => missing), 24, 23), /public availability is unconfirmed/);
  await assert.rejects(run(Array.from({ length: 24 }, () => JSON.stringify({ ...ready, "dist-tags": { beta: "old" } })), 24, 23), /public availability is unconfirmed/);
  const denied = Object.assign(new Error("unauthorized"), {
    stdout: JSON.stringify({ error: { code: "E401" } }),
  });
  await assert.rejects(run([denied], 1, 0), (error: unknown) => error === denied);
  await assert.rejects(run([JSON.stringify({ ...ready, dist: { integrity: "different" } })], 1, 0));
  await assert.rejects(run([JSON.stringify({ ...ready, version: "old" })], 1, 0));
  await assert.rejects(run(["not JSON"], 1, 0));
  await assert.rejects(run(["null"], 1, 0));
  const timedOut = new Error("request timed out");
  await assert.rejects(run([timedOut], 1, 0), (error: unknown) => error === timedOut);
  const publishJob = workflow.match(/^  publish:\n[\s\S]*?timeout-minutes: (\d+)/m);
  assert.ok(publishJob);
  // 24 reads (at most 15 seconds each) plus 23 waits need room for setup/publish too.
  assert.equal(Number(publishJob[1]), 15);
});
