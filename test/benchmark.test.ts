import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("../scripts/bench.ts", import.meta.url));
const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.NODE_PATH;

function record(input: unknown): Record<string, unknown> {
  assert.ok(typeof input === "object" && input !== null && !Array.isArray(input));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Container checked above; all fields are still unknown.
  return input as Record<string, unknown>;
}

function run(args: string[]) {
  return execute(process.execPath, args, { cwd: root, env, timeout: 60_000, maxBuffer: 1024 * 1024 });
}

describe("collection benchmark", () => {
  it("runs every smoke workload and reports finite samples with reproducible metadata", async () => {
    const output = await run(["--expose-gc", script, "--smoke", "--json"]);
    assert.equal(output.stderr, "");
    const report = record(JSON.parse(output.stdout));
    const environment = record(report.environment);
    for (const field of ["node", "v8", "os", "osRelease", "architecture", "cpu", "packageVersion", "articulatedVersion"]) {
      assert.equal(typeof environment[field], "string");
      assert.notEqual(environment[field], "");
    }
    assert.equal(environment.node, process.version);
    assert.match(String(environment.gitSha), /^[a-f0-9]{40}$/);
    assert.equal(typeof environment.dirty, "boolean");
    assert.ok(typeof environment.cpuCount === "number" && environment.cpuCount > 0);
    assert.deepEqual(report.config, { sizes: [32], samples: 2, iterations: 2, pending: 20, warmups: 1 });
    assert.ok(Array.isArray(report.results));
    assert.equal(report.results.length, 25);
    const cases = new Set<string>();
    for (const input of report.results) {
      const row = record(input);
      assert.ok(row.kind === "list" || row.kind === "text");
      assert.equal(row.size, 32);
      assert.equal(typeof row.scenario, "string");
      const key = `${row.kind}/${String(row.scenario)}`;
      assert.ok(!cases.has(key));
      cases.add(key);
      const heap = row.scenario === "retained-heap";
      assert.equal(row.unit, heap ? "bytes" : "ms/op");
      assert.equal(row.operationsPerSample, heap || row.scenario === "pending-replay" ? 1 : 2);
      assert.ok(Array.isArray(row.samples));
      assert.equal(row.samples.length, 2);
      const samples: number[] = [];
      for (const sample of row.samples) {
        assert.equal(typeof sample, "number");
        assert.ok(typeof sample === "number" && Number.isFinite(sample));
        if (!heap) assert.ok(sample >= 0);
        samples.push(sample);
      }
      assert.equal(row.min, Math.min(...samples));
      assert.equal(row.max, Math.max(...samples));
      assert.equal(row.median, (samples[0]! + samples[1]!) / 2);
      for (const field of ["snapshotBytes", "checkpointBytes"]) {
        const bytes = row[field];
        assert.ok(typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0);
      }
    }
    const scenarios = ["local-insert", "local-delete", "sync-insert", "pending-replay", "materialize",
      "snapshot", "unused-policy-snapshot", "unchanged-receive", "retained-heap"];
    const objectScenarios = ["object-json-ack", "object-own-replace-ack", "object-json-replace-ack", "object-remote-replace",
      "object-local-set", "object-json-set-ack", "object-remote-set"];
    assert.deepEqual([...cases].sort(), [...["list", "text"].flatMap((kind) => scenarios.map((scenario) => `${kind}/${scenario}`)),
      ...objectScenarios.map((scenario) => `list/${scenario}`)].sort());
  });

  it("prints readable smoke rows and does nothing when imported", async () => {
    const imported = await run(["--input-type=module", "-e", 'await import("./scripts/bench.ts")']);
    assert.equal(imported.stdout, "");
    assert.equal(imported.stderr, "");
    const output = await run(["--expose-gc", script, "--smoke"]);
    assert.equal(output.stderr, "");
    assert.match(output.stdout, /kind\tsize\tscenario\tmedian\tmin\tmax\tunit/);
    assert.equal(output.stdout.split("\n").filter((line) => /^(list|text)\t32\t/.test(line)).length, 25);
    assert.match(output.stdout, /ms\/op/);
    assert.match(output.stdout, /retained-heap.*bytes/);
    assert.match(output.stdout, /signed GC estimate/);
  });

  it("rejects invalid flags before starting a workload", async () => {
    for (const args of [["--unknown"], ["--smoke", "extra"],
      ["--worker", "text", "32", "object-json-ack", "smoke"]]) {
      await assert.rejects(run([script, ...args]), (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error && error.code === 1);
        assert.ok("stdout" in error && error.stdout === "");
        assert.ok("stderr" in error && typeof error.stderr === "string" && error.stderr.length > 0);
        return true;
      });
    }
  });
});
