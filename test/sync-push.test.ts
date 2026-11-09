import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import {
  createServer, decodeClientBatch, defineDocument, list, value, type ClientBatch, type CreateServerOptions,
} from "../src/index.ts";
import {
  connectSync, type SyncClient, type SyncPushState, type SyncSubscription, type SyncTransport,
} from "../src/sync/index.ts";

const Board = defineDocument({ items: list<string>(), count: value(0) });
type Shape = typeof Board.definition;
const wire = (input: unknown): unknown => JSON.parse(JSON.stringify(input));
const settle = async () => { for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve)); };

/** What the hub does with one delivery to one subscriber. */
type Delivery = "deliver" | "drop" | "duplicate" | "hold";

/** An in-process server whose transports push every new commit to their subscribers, with injectable faults. */
function hub(options: CreateServerOptions<Shape> = {}) {
  const server = createServer(Board, options);
  const subscribers = new Set<{ sent: number; handlers: SyncSubscription; held: unknown[] }>();
  let delivery: () => Delivery = () => "deliver";
  let lose: () => "before" | "after" | undefined = () => undefined;

  function broadcast(): void {
    for (const subscriber of [...subscribers]) {
      const commits = server.commitsSince(subscriber.sent);
      if (commits === null) { subscriber.handlers.onGap(); subscribers.delete(subscriber); continue; }
      if (commits.length === 0) continue;
      subscriber.sent = commits.at(-1)!.serverSeq;
      const payload = wire(commits);
      const mode = delivery();
      if (mode === "drop") continue;
      if (mode === "hold") { subscriber.held.push(payload); continue; }
      subscriber.handlers.onCommits(payload);
      if (mode === "duplicate") subscriber.handlers.onCommits(payload);
      // Held deliveries arrive late and out of order.
      for (const late of subscriber.held.splice(0).toReversed()) subscriber.handlers.onCommits(late);
    }
  }
  function transport(config: { push?: boolean } = {}): SyncTransport & { readonly gets: number[]; readonly opened: number[]; closed(): number } {
    const gets: number[] = [], opened: number[] = [];
    const state = { closed: 0 };
    async function apply(kind: "submit" | "reject", batch: ClientBatch): Promise<void> {
      const fault = lose();
      if (fault === "before") throw new Error("request lost");
      const decoded = decodeClientBatch(Board, wire(batch));
      if (kind === "submit") server.receive(decoded); else server.reject(decoded);
      broadcast();
      if (fault === "after") throw new Error("response lost");
    }
    const base: SyncTransport = {
      async register() { return { clientId: server.openClient(), snapshot: wire(server.snapshot()) }; },
      submit: (batch) => apply("submit", batch),
      reject: (batch) => apply("reject", batch),
      async commitsSince(watermark) { gets.push(watermark); return wire(server.commitsSince(watermark)); },
    };
    const result = Object.assign(base, { gets, opened, closed: () => state.closed });
    if (config.push === false) return result;
    return Object.assign(result, {
      subscribe(watermark: number, handlers: SyncSubscription) {
        opened.push(watermark);
        const subscriber = { sent: watermark, handlers, held: [] as unknown[] };
        subscribers.add(subscriber);
        queueMicrotask(() => { handlers.onOpen(); broadcast(); });
        return () => { state.closed++; subscribers.delete(subscriber); };
      },
    });
  }
  return { server, transport, subscribers, broadcast,
    deliver(next: () => Delivery) { delivery = next; }, faults(next: typeof lose) { lose = next; } };
}

function pushStates(client: SyncClient<Shape>) {
  const seen: SyncPushState[] = [];
  client.on("push", (state) => seen.push(state));
  return seen;
}

describe("connectSync push", () => {
  it("opens a channel after the first pass and applies pushed commits without polling or catch-up requests", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = hub();
    const ta = h.transport();
    const a = await connectSync(Board, { transport: ta, pollInterval: 1000 });
    const states = pushStates(a);
    const b = await connectSync(Board, { transport: h.transport({ push: false }), pollInterval: 0 });
    t.mock.timers.tick(0); await settle();
    assert.equal(a.push, "open");
    assert.deepEqual(states, ["connecting", "open"]);
    const gets = ta.gets.length;
    b.doc.state.items.push("pushed");
    await b.sync();
    await settle();
    assert.deepEqual(a.doc.state.items.toArray(), ["pushed"]);
    t.mock.timers.tick(10_000); await settle();
    assert.equal(ta.gets.length, gets, "no catch-up request and no polling while the channel is open");
    // A pass that ends while the channel is open does not restart polling either.
    a.doc.state.items.push("local");
    await a.sync();
    const afterPass = ta.gets.length;
    t.mock.timers.tick(10_000); await settle();
    assert.equal(ta.gets.length, afterPass, "still no polling after a pass");
    a.stop(); b.stop();
    assert.equal(ta.closed(), 1);
    assert.equal(a.push, "off");
  });

  it("ignores duplicates and falls back to catch-up when pushed commits do not continue the watermark", async () => {
    const h = hub();
    const ta = h.transport();
    const a = await connectSync(Board, { transport: ta, pollInterval: 0, pushTimeout: 0 });
    const b = await connectSync(Board, { transport: h.transport({ push: false }), pollInterval: 0 });
    await a.sync(); await settle();
    assert.equal(a.push, "open");
    h.deliver(() => "duplicate");
    b.doc.state.count.value = 1; await b.sync(); await settle();
    const gets = ta.gets.length;
    assert.equal(a.doc.state.count.value, 1);
    h.deliver(() => "drop");
    b.doc.state.count.value = 2; await b.sync(); await settle();
    assert.equal(a.doc.state.count.value, 1, "a dropped push is not noticed until the next one");
    h.deliver(() => "deliver");
    b.doc.state.count.value = 3; await b.sync(); await settle();
    assert.equal(a.doc.state.count.value, 3);
    assert.equal(ta.gets.length, gets + 1, "one catch-up request filled the gap");
    a.stop(); b.stop();
  });

  it("reconnects with backoff when the channel ends or goes silent, polling meanwhile", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(Math, "random", () => 1);
    const h = hub();
    const ta = h.transport();
    const a = await connectSync(Board, { transport: ta, pollInterval: 1000, pushTimeout: 5000, retry: { initialDelay: 100, maxDelay: 400 } });
    t.mock.timers.tick(0); await settle();
    assert.deepEqual(ta.opened, [0]);
    const subscriber = [...h.subscribers][0]!;
    subscriber.handlers.onEnd(new Error("connection reset"));
    await settle();
    assert.equal(a.push, "off");
    const gets = ta.gets.length;
    assert.ok(gets >= 2, "losing the channel triggers an immediate catch-up");
    t.mock.timers.tick(99); await settle();
    assert.equal(ta.opened.length, 1);
    t.mock.timers.tick(1); await settle();
    assert.equal(ta.opened.length, 2, "reconnected after the backoff");
    assert.equal(a.push, "open");
    t.mock.timers.tick(4999); await settle();
    assert.equal(a.push, "open", "pushTimeout counts from the last traffic or the reconnection");
    t.mock.timers.tick(1); await settle();
    assert.equal(a.push, "off", "silence closes the channel");
    // The last channel opened successfully, so the backoff starts over.
    t.mock.timers.tick(99); await settle();
    assert.equal(ta.opened.length, 2);
    t.mock.timers.tick(1); await settle();
    assert.equal(ta.opened.length, 3);
    const opened = ta.opened.length;
    subscriber.handlers.onEnd(); // A stale channel's late report is ignored.
    await settle();
    assert.equal(a.push, "open");
    assert.equal(ta.opened.length, opened);
    a.stop();
  });

  it("stops at a pushed gap, closes on failure and stays off with push: false", async () => {
    const h = hub({ historyLimit: 1 });
    const a = await connectSync(Board, { transport: h.transport(), pollInterval: 0 });
    await a.sync(); await settle();
    const subscriber = [...h.subscribers][0]!;
    const writer = h.server.openClient();
    // Two commits past a one-commit history, without pushing them.
    h.server.receive({ clientId: writer, seq: 1, operations: [{ type: "value/set", path: "count", value: 1 }] });
    h.server.receive({ clientId: writer, seq: 2, operations: [{ type: "value/set", path: "count", value: 2 }] });
    subscriber.handlers.onGap();
    await settle();
    assert.equal(a.status, "gap");
    assert.equal(a.push, "off");

    const plain = h.transport({ push: false });
    const off = await connectSync(Board, { transport: plain, pollInterval: 0 });
    await off.sync(); await settle();
    assert.equal(off.push, "off");
    const disabled = h.transport();
    const optOut = await connectSync(Board, { transport: disabled, pollInterval: 0, push: false });
    await optOut.sync(); await settle();
    assert.deepEqual(disabled.opened, []);

    const failing = h.transport();
    const broken = await connectSync(Board, { transport: failing, pollInterval: 0 });
    await broken.sync(); await settle();
    assert.equal(broken.push, "open");
    [...h.subscribers].at(-1)!.handlers.onCommits([{ not: "a commit" }]);
    await settle();
    assert.equal(broken.status, "failed");
    assert.equal(broken.push, "off");
    assert.equal(failing.closed(), 1);
    for (const client of [off, optOut]) client.stop();
  });

  it("saves after applying pushed commits and fails when a document listener throws", async () => {
    const h = hub();
    const saved: number[] = [];
    const a = await connectSync(Board, { transport: h.transport(), pollInterval: 0, save: (checkpoint) => { saved.push(checkpoint.snapshot.serverSeq); } });
    const b = await connectSync(Board, { transport: h.transport({ push: false }), pollInterval: 0 });
    await a.sync(); await settle();
    assert.equal(a.push, "open");
    b.doc.state.count.value = 1; await b.sync(); await settle();
    assert.equal(saved.at(-1), 1);
    const bug = new Error("observer bug");
    a.doc.on("change", () => { throw bug; });
    b.doc.state.count.value = 2; await b.sync(); await settle();
    assert.equal(a.status, "failed");
    assert.ok(a.error instanceof Error && a.error.cause === bug, "a listener bug is not retried");
    assert.equal(a.doc.state.count.value, 2, "the commit was applied before the listener threw");
    b.stop();
  });

  for (const seed of [1, 42, 2026]) it(`converges with lossy, duplicated and reordered pushes seed=${seed}`, async () => {
    const h = hub();
    let state = seed;
    const random = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
    const clients: SyncClient<Shape>[] = [];
    for (let index = 0; index < 3; index++) {
      clients.push(await connectSync(Board, { transport: h.transport(), pollInterval: 0, pushTimeout: 0, retry: { initialDelay: 60_000 } }));
    }
    for (const client of clients) await client.sync();
    await settle();
    assert.ok(clients.every((client) => client.push === "open"));
    h.deliver(() => (["deliver", "deliver", "drop", "duplicate", "hold"] as const)[random(5)]!);
    h.faults(() => { const roll = random(10); return roll === 0 ? "before" : roll === 1 ? "after" : undefined; });
    let next = 0;
    for (let step = 0; step < 150; step++) {
      const client = clients[random(3)]!;
      if (random(3) === 0) await client.sync().catch(() => {});
      else client.doc.state.items.push(`item-${next++}`);
      if (random(4) === 0) await settle();
    }
    h.deliver(() => "deliver");
    h.faults(() => undefined);
    for (let round = 0; round < 2; round++) for (const client of clients) assert.equal(await client.sync(), true);
    await settle();
    const values = h.server.snapshot().data.items.values;
    assert.deepEqual([...values].sort(), Array.from({ length: next }, (_, index) => `item-${index}`).sort());
    for (const client of clients) {
      assert.deepEqual(client.doc.state.items.toArray(), values);
      assert.notEqual(client.status, "failed");
      client.stop();
    }
  });
});
