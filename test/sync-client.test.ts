import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import {
  createServer, decodeClientBatch, decodeClientCheckpoint, defineDocument, list, value,
  type ClientBatch, type ClientCheckpoint, type CreateServerOptions,
} from "../src/index.ts";
import { connectSync, type SyncClient, type SyncStatus, type SyncTransport } from "../src/sync/index.ts";

const Board = defineDocument({ items: list<string>(), count: value(0) });
type Shape = typeof Board.definition;
/** A JSON round trip, as over a network. */
const wire = (input: unknown): unknown => JSON.parse(JSON.stringify(input));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Fault = "before" | "after" | Error | undefined;

/** An in-process server behind a JSON transport whose submissions can fail before or after the server applies them. */
function harness(options: CreateServerOptions<Shape> = {}) {
  const server = createServer(Board, options);
  const calls: string[] = [];
  let nextFault: (call: string) => Fault = () => undefined;
  function transport(): SyncTransport & { readonly calls: string[] } {
    const own: string[] = [];
    const record = (call: string) => { own.push(call); calls.push(call); };
    async function apply(kind: "submit" | "reject", batch: ClientBatch): Promise<void> {
      record(`${kind}:${batch.clientId}:${batch.seq}`);
      const fault = nextFault(kind);
      if (fault instanceof Error) throw fault;
      if (fault === "before") throw new Error("request lost");
      const decoded = decodeClientBatch(Board, wire(batch));
      if (kind === "submit") server.receive(decoded); else server.reject(decoded);
      if (fault === "after") throw new Error("response lost");
    }
    return {
      calls: own,
      async register() { record("register"); return { clientId: server.openClient(), snapshot: wire(server.snapshot()) }; },
      submit: (batch) => apply("submit", batch),
      reject: (batch) => apply("reject", batch),
      async commitsSince(watermark) {
        record(`commits:${watermark}`);
        const fault = nextFault("commits");
        if (fault instanceof Error) throw fault;
        if (fault !== undefined) throw new Error("catch-up lost");
        return wire(server.commitsSince(watermark));
      },
    };
  }
  return { server, calls, transport, fault(next: (call: string) => Fault) { nextFault = next; } };
}

function statuses(client: { on(event: "status", listener: (status: SyncStatus) => void): () => void }) {
  const seen: SyncStatus[] = [];
  client.on("status", (status) => seen.push(status));
  return seen;
}

describe("connectSync", () => {
  it("registers, submits local edits automatically and converges two writers", async () => {
    const h = harness();
    const a = await connectSync(Board, { transport: h.transport(), pollInterval: 0 });
    const b = await connectSync(Board, { transport: h.transport(), pollInterval: 0 });
    const seenA = statuses(a);
    a.doc.state.items.push("one");
    a.doc.state.items.push("two");
    assert.deepEqual(h.server.snapshot().data.items.values, []);
    await tick(); await tick();
    assert.equal(await a.sync(), true);
    assert.deepEqual(h.server.snapshot().data.items.values, ["one", "two"]);
    assert.equal(await b.sync(), true);
    assert.deepEqual(b.doc.state.items.toArray(), ["one", "two"]);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
    assert.equal(seenA[0], "syncing");
    assert.equal(a.status, "idle");
    a.stop(); b.stop();
  });

  it("acknowledges a submission whose response was lost instead of sending it twice", async () => {
    const h = harness();
    const a = await connectSync(Board, { transport: h.transport(), pollInterval: 0, retry: { initialDelay: 60_000 } });
    let lose = true;
    h.fault((call) => call === "submit" && lose ? (lose = false, "after") : undefined);
    a.doc.state.items.push("once");
    assert.equal(await a.sync(), false);
    assert.equal(a.status, "retrying");
    assert.equal(await a.sync(), true);
    assert.deepEqual(h.server.snapshot().data.items.values, ["once"]);
    assert.equal(h.calls.filter((call) => call.startsWith("submit")).length, 1, "catch-up acknowledged it; no resend");
    a.stop();
  });

  it("resends a submission whose request never arrived", async () => {
    const h = harness();
    const a = await connectSync(Board, { transport: h.transport(), pollInterval: 0, retry: { initialDelay: 60_000 } });
    let lose = true;
    h.fault((call) => call === "submit" && lose ? (lose = false, "before") : undefined);
    a.doc.state.items.push("retried");
    assert.equal(await a.sync(), false);
    assert.equal(await a.sync(), true);
    assert.deepEqual(h.server.snapshot().data.items.values, ["retried"]);
    assert.equal(h.calls.filter((call) => call.startsWith("submit")).length, 2);
    a.stop();
  });

  it("backs off exponentially up to the limit and resets after a successful pass", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(Math, "random", () => 1); // Upper end of the jitter range: the full delay.
    const h = harness();
    let failing = true;
    h.fault((call) => call === "commits" && failing ? new Error("offline") : undefined);
    const a = await connectSync(Board, { transport: h.transport(), pollInterval: 0, retry: { initialDelay: 100, maxDelay: 400 } });
    const attempts = () => h.calls.filter((call) => call.startsWith("commits")).length;
    await a.sync().catch(() => {});
    for (const delay of [100, 200, 400, 400]) {
      const before = attempts();
      t.mock.timers.tick(delay - 1); await tick();
      assert.equal(attempts(), before, `no retry before ${delay} ms`);
      t.mock.timers.tick(1); await tick(); await tick();
      assert.equal(attempts(), before + 1, `retry after ${delay} ms`);
    }
    failing = false;
    t.mock.timers.tick(400); await tick(); await tick();
    assert.equal(a.status, "idle");
    failing = true;
    await a.sync();
    const before = attempts();
    t.mock.timers.tick(100); await tick(); await tick();
    assert.equal(attempts(), before + 1, "the delay starts over after success");
    a.stop();
  });

  it("fails without retrying on non-retryable errors, protocol violations and save failures", async () => {
    for (const scenario of ["non-retryable", "gapless-order", "bad-commit", "no-ack", "save"] as const) {
      const h = harness();
      const transport = h.transport();
      const failure = Object.assign(new Error("forbidden"), { retryable: false });
      const saveError = new Error("disk full");
      let saves = 0;
      const a = await connectSync(Board, { pollInterval: 0, transport: {
        ...transport,
        async submit(batch) {
          if (scenario === "non-retryable") throw failure;
          if (scenario !== "no-ack") await transport.submit(batch);
        },
        async commitsSince(watermark) {
          const commits = await transport.commitsSince(watermark);
          if (!Array.isArray(commits) || commits.length === 0) return commits;
          const first: unknown = commits[0];
          if (scenario === "gapless-order") return [{ ...(typeof first === "object" ? first : {}), serverSeq: 99 }];
          if (scenario === "bad-commit") return [{ nonsense: true }];
          return commits as unknown;
        },
      }, save() { if (scenario === "save" && ++saves > 1) throw saveError; } });
      a.doc.state.items.push("x");
      await assert.rejects(a.sync(), scenario);
      assert.equal(a.status, "failed", scenario);
      const callsAfterFailure = h.calls.length;
      await assert.rejects(a.sync(), (error) => error === a.error, scenario);
      assert.equal(h.calls.length, callsAfterFailure, `${scenario}: nothing is sent after failing`);
      if (scenario === "non-retryable") assert.equal(a.error, failure);
      if (scenario === "save") {
        assert.equal(a.error, saveError);
        assert.equal(h.calls.filter((call) => call.startsWith("submit")).length, 0, "pending is never sent unsaved");
      }
      a.stop();
      assert.equal(a.status, "failed", "stop keeps the failure visible");
    }
  });

  it("saves pending work before sending it and the watermark after receiving", async () => {
    const h = harness();
    const transport = h.transport();
    const saved: ClientCheckpoint<Shape>[] = [];
    const a = await connectSync(Board, { pollInterval: 0, save: (checkpoint) => { saved.push(checkpoint); }, transport: {
      ...transport,
      async submit(batch) {
        const last = saved.at(-1)!;
        assert.ok(last.pendingBatches.some((pending) => pending.seq === batch.seq), "the batch was saved before sending");
        await transport.submit(batch);
      },
    } });
    assert.equal(saved.length, 1, "a fresh connection is saved before use");
    a.doc.state.items.push("a");
    a.doc.state.items.push("b");
    assert.equal(await a.sync(), true);
    const last = saved.at(-1)!;
    assert.deepEqual(last.pendingBatches, []);
    assert.equal(last.snapshot.serverSeq, 2, "own acknowledgements are saved even without change events");
    a.stop();
  });

  it("stops submitting while blocked and resumes after rejecting pending work", async () => {
    let rejectInserts = false;
    const h = harness({ resolve: ({ batch }) => rejectInserts && batch.operations.some((operation) => operation.type === "list/insert") ? [] : batch.operations });
    const a = await connectSync(Board, { transport: h.transport(), pollInterval: 0 });
    a.doc.state.items.push("base");
    await a.sync();
    rejectInserts = true;
    a.doc.state.items.push("rejected");
    a.doc.state.count.value = 1; // Replayable: sent although a later batch blocks.
    a.doc.state.items.delete(1); // Depends on the insertion the server will reject.
    assert.equal(await a.sync(), false);
    assert.equal(a.status, "blocked");
    assert.equal(a.doc.replayConflict?.batch.seq, 4);
    assert.equal(h.server.snapshot().data.count, 1, "the batch before the conflict was acknowledged");
    assert.deepEqual(a.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [4]);
    const submitted = h.calls.filter((call) => call.startsWith("submit")).length;
    assert.equal(await a.sync(), false, "a blocked client does not submit");
    assert.equal(h.calls.filter((call) => call.startsWith("submit")).length, submitted);
    assert.equal(await a.rejectPending(), true);
    assert.equal(a.status, "idle");
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
    assert.deepEqual(a.doc.state.items.toArray(), ["base"]);
    a.stop();
  });

  it("stops at a history gap, keeps pending work and restarts from a snapshot only without it", async () => {
    const h = harness({ historyLimit: 1 });
    const a = await connectSync(Board, { transport: h.transport(), pollInterval: 0 });
    const b = await connectSync(Board, { transport: h.transport(), pollInterval: 0 });
    for (let index = 0; index < 3; index++) { b.doc.state.count.value = index + 1; await b.sync(); }
    a.doc.state.items.push("offline");
    assert.equal(await a.sync(), false);
    assert.equal(a.status, "gap");
    assert.equal(a.doc.checkpoint().pendingBatches.length, 1);
    await assert.rejects(a.restartFromSnapshot(), /discard pending work/);

    const c = await connectSync(Board, { transport: h.transport(), pollInterval: 0 });
    for (let index = 0; index < 3; index++) { b.doc.state.count.value = 10 + index; await b.sync(); }
    assert.equal(await c.sync(), false);
    assert.equal(c.status, "gap");
    const fresh = await c.restartFromSnapshot();
    assert.equal(c.status, "stopped");
    assert.notEqual(fresh.doc.checkpoint().clientId, c.doc.checkpoint().clientId);
    assert.equal(fresh.doc.state.count.value, 12);
    for (const client of [a, b, fresh]) client.stop();
  });

  it("runs one pass for edits made together and shares a pass between concurrent sync() calls", async () => {
    const h = harness();
    const a = await connectSync(Board, { transport: h.transport(), pollInterval: 0 });
    const before = h.calls.length;
    a.doc.state.items.push("1"); a.doc.state.items.push("2"); a.doc.state.items.push("3");
    const first = a.sync(), second = a.sync();
    assert.equal(first, second);
    assert.equal(await first, true);
    await tick(); await tick();
    const pass = h.calls.slice(before);
    assert.equal(pass.filter((call) => call.startsWith("submit")).length, 3);
    assert.equal(pass.filter((call) => call.startsWith("commits")).length, 4, "one catch-up, then one per acknowledgement");
    a.stop();
  });

  it("ignores responses after stop() and runs no timers", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    const transport = h.transport();
    let release: (() => void) | undefined;
    const a = await connectSync(Board, { pollInterval: 1000, transport: {
      ...transport,
      async submit(batch) { await new Promise<void>((resolve) => { release = resolve; }); await transport.submit(batch); },
    } });
    a.doc.state.items.push("late");
    const pending = a.sync();
    await tick();
    a.stop(); a.stop();
    release!();
    assert.equal(await pending, false);
    assert.equal(a.status, "stopped");
    const calls = h.calls.length;
    t.mock.timers.tick(10_000); await tick();
    assert.equal(h.calls.length, calls, "no catch-up after the stopped submission and no polling");
    await assert.rejects(a.sync(), /stopped/);
  });

  it("polls for remote commits and fails when a status listener throws", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    const a = await connectSync(Board, { transport: h.transport(), pollInterval: 1000 });
    const b = await connectSync(Board, { transport: h.transport(), pollInterval: 0 });
    t.mock.timers.tick(0); await tick(); await tick();
    b.doc.state.items.push("remote");
    await b.sync();
    assert.deepEqual(a.doc.state.items.toArray(), []);
    t.mock.timers.tick(1000); await tick(); await tick();
    assert.deepEqual(a.doc.state.items.toArray(), ["remote"]);
    const bug = new Error("listener bug");
    a.on("status", () => { throw bug; });
    await assert.rejects(a.sync(), /status listener threw/);
    assert.equal(a.status, "failed");
    assert.ok(a.error instanceof Error);
    assert.equal(a.error.cause, bug);
    b.stop();
  });

  it("restores from a checkpoint without registering and resends pending work after catching up", async () => {
    const h = harness();
    const first = await connectSync(Board, { transport: h.transport(), pollInterval: 0 });
    let lose = true;
    h.fault((call) => call === "submit" && lose ? (lose = false, "after") : undefined);
    first.doc.state.items.push("accepted");
    first.doc.state.items.push("unsent");
    await first.sync();
    first.stop();
    const saved = decodeClientCheckpoint(Board, wire(first.doc.checkpoint()));
    assert.equal(saved.pendingBatches.length, 2);
    const transport = h.transport();
    const resumed = await connectSync(Board, { transport, checkpoint: saved, pollInterval: 0 });
    assert.equal(await resumed.sync(), true);
    assert.ok(!transport.calls.includes("register"));
    assert.deepEqual(h.server.snapshot().data.items.values, ["accepted", "unsent"]);
    assert.deepEqual(transport.calls.filter((call) => call.startsWith("submit")).map((call) => call.split(":")[2]), ["2"]);
    resumed.stop();
  });

  for (const seed of [1, 42, 2026]) it(`delivers every batch exactly once over a lossy transport seed=${seed}`, async () => {
    const h = harness();
    let state = seed;
    const random = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
    const clients: SyncClient<Shape>[] = [];
    for (let index = 0; index < 3; index++) {
      clients.push(await connectSync(Board, { transport: h.transport(), pollInterval: 0, retry: { initialDelay: 60_000 } }));
    }
    h.fault(() => { const roll = random(10); return roll === 0 ? "before" : roll === 1 ? "after" : undefined; });
    let next = 0;
    for (let step = 0; step < 200; step++) {
      const client = clients[random(3)]!;
      if (random(3) === 0) await client.sync().catch(() => {});
      else client.doc.state.items.push(`item-${next++}`);
    }
    h.fault(() => undefined);
    for (let round = 0; round < 2; round++) for (const client of clients) assert.equal(await client.sync(), true);
    const values = h.server.snapshot().data.items.values;
    assert.deepEqual([...values].sort(), Array.from({ length: next }, (_, index) => `item-${index}`).sort(), "no loss and no duplicates");
    for (const client of clients) {
      assert.deepEqual(client.doc.state.items.toArray(), values);
      assert.deepEqual(client.doc.checkpoint().pendingBatches, []);
      client.stop();
    }
  });
});
