import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    assert.equal(report.results.length, 33);
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
      "object-local-set", "object-json-set-ack", "object-remote-set", "object-remote-set-pending-same", "object-remote-set-pending-disjoint",
      "object-remote-replace-pending-same", "object-remote-replace-pending-disjoint", "object-json-mixed-ack"];
    assert.deepEqual([...cases].sort(), [...["list", "text"].flatMap((kind) => scenarios.map((scenario) => `${kind}/${scenario}`)),
      ...objectScenarios.map((scenario) => `list/${scenario}`),
      ...["remote-replace-pending-same", "remote-replace-pending-disjoint", "value-json-mixed-ack"].map((scenario) => `text/${scenario}`)].sort());
  });

  it("prints readable smoke rows and does nothing when imported", async () => {
    const imported = await run(["--input-type=module", "-e", 'await import("./scripts/bench.ts")']);
    assert.equal(imported.stdout, "");
    assert.equal(imported.stderr, "");
    const output = await run(["--expose-gc", script, "--smoke"]);
    assert.equal(output.stderr, "");
    assert.match(output.stdout, /kind\tsize\tscenario\tmedian\tmin\tmax\tunit/);
    assert.equal(output.stdout.split("\n").filter((line) => /^(list|text)\t32\t/.test(line)).length, 33);
    assert.match(output.stdout, /ms\/op/);
    assert.match(output.stdout, /retained-heap.*bytes/);
    assert.match(output.stdout, /signed GC estimate/);
  });

  it("runs the extended matrix with reproducible fragmented fixtures across two runs", async () => {
    const fingerprints: unknown[][] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = await run(["--expose-gc", script, "--extended", "--smoke", "--json"]);
      assert.equal(output.stderr, "");
      const report = record(JSON.parse(output.stdout)), environment = record(report.environment);
      assert.equal(environment.node, process.version);
      assert.match(String(environment.gitSha), /^[a-f0-9]{40}$/);
      assert.equal(typeof environment.dirty, "boolean");
      assert.deepEqual(report.config, { sizes: [32], samples: 2, iterations: 2, pending: 20, warmups: 1,
        historyLimits: [0, 2, 4, 8], seed: 42 });
      assert.ok(Array.isArray(report.results));
      assert.equal(report.results.length, 13);
      const cases: string[] = [], structures: unknown[] = [];
      for (const input of report.results) {
        const row = record(input), heap = row.scenario === "retained-heap";
        assert.ok(row.kind === "text" || row.kind === "history");
        cases.push(`${row.kind}/${String(row.size)}/${String(row.scenario)}`);
        assert.equal(row.unit, heap ? "bytes" : "ms/op");
        const once = ["bulk-delete", "pending-replay", "client-decode-restore", "server-decode-restore", "retained-heap"].includes(String(row.scenario));
        assert.equal(row.operationsPerSample, once ? 1 : 2);
        assert.ok(Array.isArray(row.samples));
        assert.equal(row.samples.length, 2);
        const samples: number[] = [];
        for (const sample of row.samples) {
          assert.ok(typeof sample === "number" && Number.isFinite(sample));
          if (!heap) assert.ok(sample >= 0);
          samples.push(sample);
        }
        assert.equal(row.min, Math.min(...samples));
        assert.equal(row.max, Math.max(...samples));
        assert.equal(row.median, (samples[0]! + samples[1]!) / 2);
        for (const field of ["snapshotBytes", "checkpointBytes"]) {
          assert.ok(typeof row[field] === "number" && Number.isSafeInteger(row[field]) && row[field] > 0);
        }
        if (row.kind === "text") {
          assert.equal(row.size, 32);
          const fixture = record(row.fixture);
          assert.deepEqual(fixture, { seed: 42, visibleIds: 32, deletedIds: 8, savedRanges: 33, bunches: 21,
            snapshotSha256: "7244aba77c8395d87cf78798d8abbc761e661672f3942534baa1c6d1873ef13b" });
          structures.push([row.kind, row.size, row.scenario, fixture, row.snapshotBytes, row.checkpointBytes]);
        } else {
          assert.equal(row.fixture, undefined);
          structures.push([row.kind, row.size, row.scenario, row.snapshotBytes, row.checkpointBytes]);
        }
      }
      const scenarios = ["local-insert", "local-delete", "bulk-delete", "remote-replace", "remote-noop-delete",
        "pending-replay", "client-decode-restore", "server-decode-restore", "retained-heap"];
      assert.deepEqual(cases.toSorted(), [...scenarios.map((scenario) => `text/32/${scenario}`),
        ...[0, 2, 4, 8].map((limit) => `history/${limit}/history-receive`)].toSorted());
      fingerprints.push(structures);
    }
    assert.deepEqual(fingerprints[0], fingerprints[1]);
  });

  it("prints extended units and measurement boundaries without mixing in original workloads", async () => {
    const output = await run(["--expose-gc", script, "--extended", "--smoke"]);
    assert.equal(output.stderr, "");
    assert.equal(output.stdout.split("\n").filter((line) => /^(text|history)\t/.test(line)).length, 13);
    assert.doesNotMatch(output.stdout, /^list\t/m);
    assert.match(output.stdout, /history size is commit capacity/);
    assert.match(output.stdout, /decode \+ constructor, excluding JSON.parse/);
    assert.match(output.stdout, /signed GC estimate/);
  });

  it("writes isolated receive-only profiles with consistent samples and never overwrites a previous run", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "articollab-profile-test-")));
    try {
      const directories: string[] = [];
      let previousManifest = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const output = await run(["--expose-gc", script, "--profile-remote-replace", directory, "--smoke",
          ...(attempt === 0 ? ["--json"] : [])]);
        assert.equal(output.stderr, "");
        let manifest: Record<string, unknown>;
        if (attempt === 0) manifest = record(JSON.parse(output.stdout));
        else {
          const match = output.stdout.match(/^Receive-only Text profiles: (.+)$/m);
          assert.ok(match);
          assert.match(output.stdout, /control and profiled wall times are separate/);
          manifest = record(JSON.parse(await readFile(join(match[1]!, "manifest.json"), "utf8")));
        }
        assert.equal(typeof manifest.directory, "string");
        assert.ok(typeof manifest.directory === "string" && manifest.directory.startsWith(directory));
        directories.push(manifest.directory);
        const saved = await readFile(join(manifest.directory, "manifest.json"), "utf8");
        assert.deepEqual(JSON.parse(saved), manifest);
        if (attempt === 0) previousManifest = saved;
        assert.equal(record(manifest.environment).node, process.version);
        assert.deepEqual(manifest.config, { sizes: [32], samples: 2, iterations: 2, warmups: 1, seed: 42, samplingIntervalMicros: 1000 });
        assert.ok(Array.isArray(manifest.results));
        assert.equal(manifest.results.length, 1);
        const pair = record(manifest.results[0]), control = record(pair.control), profiled = record(pair.profiled);
        assert.deepEqual(control.fixture, profiled.fixture);
        assert.equal(record(control.fixture).snapshotSha256, "7244aba77c8395d87cf78798d8abbc761e661672f3942534baa1c6d1873ef13b");
        assert.equal(control.snapshotBytes, profiled.snapshotBytes);
        assert.equal(control.checkpointBytes, profiled.checkpointBytes);
        assert.equal(profiled.operationsPerSample, 2);
        assert.ok(Array.isArray(control.samples));
        assert.equal(control.samples.length, 2);
        assert.ok(control.samples.every((sample) => typeof sample === "number" && Number.isFinite(sample) && sample >= 0));
        assert.deepEqual(JSON.parse(await readFile(join(manifest.directory, "control-32.json"), "utf8")), control);
        assert.ok(Array.isArray(profiled.profiles));
        assert.equal(profiled.profiles.length, 2);
        const files = ["manifest.json", "control-32.json"];
        for (const [index, input] of profiled.profiles.entries()) {
          const entry = record(input);
          assert.equal(entry.profile, `text-32-${index + 1}.cpuprofile`);
          assert.equal(entry.summary, `text-32-${index + 1}.summary.json`);
          assert.ok(typeof entry.wallMsPerOp === "number" && Number.isFinite(entry.wallMsPerOp) && entry.wallMsPerOp >= 0);
          const profileFile = entry.profile, summaryFile = entry.summary;
          files.push(profileFile, summaryFile);
          const profile = record(JSON.parse(await readFile(join(manifest.directory, profileFile), "utf8")));
          const summary = record(JSON.parse(await readFile(join(manifest.directory, summaryFile), "utf8")));
          assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0);
          assert.ok(Array.isArray(profile.samples) && Array.isArray(profile.timeDeltas));
          assert.equal(profile.samples.length, profile.timeDeltas.length);
          let total = 0;
          for (const delta of profile.timeDeltas) {
            assert.ok(typeof delta === "number" && Number.isFinite(delta) && delta >= 0);
            total += delta;
          }
          assert.equal(summary.totalSampleMicros, total);
          assert.equal(summary.sampleCount, profile.samples.length);
          const groups = record(summary.groups), equality = record(summary.equality);
          const sum = (values: unknown[]) => values.reduce<number>((accumulator, value) => {
            assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0);
            return accumulator + value;
          }, 0);
          assert.deepEqual(Object.keys(groups).sort(), ["authoritativeApply", "visibleEquality", "otherRuntime", "gc", "profilerOrUnattributed"].sort());
          assert.equal(sum(Object.values(groups)), total);
          assert.equal(sum(Object.values(equality)), groups.visibleEquality);
          for (const [key, value] of Object.entries(groups)) {
            assert.equal(record(summary.groupPercent)[key], total === 0 ? 0 : Number(value) / total * 100);
          }
          assert.ok(Array.isArray(summary.functions));
          let self = 0;
          for (const row of summary.functions) {
            const fn = record(row);
            assert.ok(typeof fn.selfMicros === "number" && typeof fn.inclusiveMicros === "number" && fn.inclusiveMicros >= fn.selfMicros);
            self += fn.selfMicros;
          }
          assert.equal(self, total);
          // Setup, materialization and assertions must not appear as sampled leaf work.
          const frames = new Map(profile.nodes.map((node: unknown) => {
            const row = record(node); return [row.id, record(row.callFrame)];
          }));
          for (const id of profile.samples) assert.ok(!["fragmentedFixture", "prepareFragmentedEdit", "verify", "collect"].includes(String(frames.get(id)?.functionName)));
        }
        assert.deepEqual((await readdir(manifest.directory)).sort(), files.sort());
      }
      assert.notEqual(directories[0], directories[1]);
      assert.equal(await readFile(join(directories[0]!, "manifest.json"), "utf8"), previousManifest);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("disconnects on profiling failure and preserves that error over a cleanup error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "articollab-profile-failure-"));
    try {
      const log = join(directory, "lifecycle.json");
      for (const failAt of ["Profiler.start", "Profiler.stop"]) {
        const preload = `import { Session } from 'node:inspector/promises';
          import { writeFileSync } from 'node:fs';
          const originalPost = Session.prototype.post, originalDisconnect = Session.prototype.disconnect, events = [];
          Session.prototype.post = function(method, params) {
            events.push(method);
            if (method === ${JSON.stringify(failAt)}) throw new Error('profile-primary-failure');
            return originalPost.call(this, method, params);
          };
          Session.prototype.disconnect = function() {
            events.push('disconnect'); originalDisconnect.call(this); throw new Error('cleanup-secondary-failure');
          };
          process.on('exit', () => writeFileSync(${JSON.stringify(log)}, JSON.stringify(events)));`;
        await assert.rejects(run(["--expose-gc", "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
          script, "--profile-worker", "32", "smoke", directory]), (error: unknown) => {
          assert.ok(error instanceof Error && "stderr" in error && typeof error.stderr === "string");
          assert.match(error.stderr, /^Error: profile-primary-failure$/m);
          assert.doesNotMatch(error.stderr, /^Error: cleanup-secondary-failure$/m);
          return true;
        });
        assert.deepEqual(JSON.parse(await readFile(log, "utf8")), ["Profiler.enable", "Profiler.setSamplingInterval", "Profiler.start",
          ...(failAt === "Profiler.stop" ? ["Profiler.stop", "Profiler.stop"] : []), "disconnect"]);
        assert.deepEqual(await readdir(directory), ["lifecycle.json"]);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("validates profile output and mode before creating artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "articollab-profile-invalid-"));
    try {
      for (const args of [["--profile-remote-replace"], ["--profile-remote-replace", ""],
        ["--profile-remote-replace", directory, "--extended"], ["--profile-remote-replace", directory, "extra"],
        ["--profile-remote-replace", join(directory, "missing")], ["--profile-remote-replace", script],
        ["--profile-remote-replace", root], ["--profile-worker", "32", "full", directory],
        ["--profile-worker", "33", "smoke", directory], ["--profile-worker", "32", "smoke", root]]) {
        await assert.rejects(run([script, ...args]));
        assert.deepEqual(await readdir(directory), []);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects invalid flags before starting a workload", async () => {
    for (const args of [["--unknown"], ["--smoke", "extra"],
      ["--worker", "text", "32", "object-json-ack", "smoke"], ["--extended", "extra"],
      ["--worker", "text", "32", "object-remote-set-pending-same", "smoke"],
      ["--worker", "list", "32", "value-json-mixed-ack", "smoke"],
      ["--extended-worker", "list", "32", "local-insert", "smoke"],
      ["--extended-worker", "history", "3", "history-receive", "smoke"],
      ["--extended-worker", "text", "32", "history-receive", "smoke"],
      ["--extended-worker", "history", "2", "local-insert", "smoke"],
      ["--extended-worker", "text", "10000", "local-insert", "smoke"],
      ["--extended-worker", "text", "32", "local-insert", "full"],
      ["--extended-worker", "text", "32", "unknown", "smoke"]]) {
      await assert.rejects(run([script, ...args]), (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error && error.code === 1);
        assert.ok("stdout" in error && error.stdout === "");
        assert.ok("stderr" in error && typeof error.stderr === "string" && error.stderr.length > 0);
        return true;
      });
    }
  });
});
