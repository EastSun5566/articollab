import assert from "node:assert/strict";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { describe, it, type TestContext } from "node:test";

import {
  createServer, decodeServerCommit, decodeSnapshot, defineDocument, list, value, type ServerCheckpoint,
} from "../packages/articollab/src/index.ts";
import {
  connectSync, createHttpTransport, createSyncHandler, SyncRequestError,
  type SyncAction, type SyncHandlerOptions,
} from "../packages/articollab/src/sync/index.ts";
import { runSyncAdapterDemo, serveFetch } from "../examples/sync-adapter.ts";
import { toNodeListener } from "../examples/shared/fetch-bridge.ts";
import { readServerSentEvents, type ServerSentEvent } from "../packages/articollab/src/sync/sse.ts";

const Board = defineDocument({ items: list<string>(), count: value(0) });
type Shape = typeof Board.definition;
const base = "http://sync.test/api/";

function setup(options: SyncHandlerOptions<Shape> = {}) {
  const server = createServer(Board);
  const handle = createSyncHandler(Board, server, options);
  const post = (route: string, body: unknown, headers: HeadersInit = { "Content-Type": "application/json" }) =>
    handle(new Request(base + route, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
  const get = (route: string) => handle(new Request(base + route));
  return { server, handle, post, get };
}
const batch = (clientId: string, seq: number, count = seq) =>
  ({ clientId, seq, operations: [{ type: "value/set" as const, path: "count" as const, value: count }] });
const insert = (clientId: string, item: string) => ({
  clientId, seq: 1, operations: [{
    type: "list/insert" as const, path: "items" as const, before: null,
    id: { bunchId: JSON.stringify([clientId, "items", 1]), counter: 0 }, value: item,
  }],
});

/** Serves a Fetch handler through the example's node:http bridge for real-socket tests. */
async function serve(t: TestContext, handle: (request: Request) => Promise<Response>): Promise<string> {
  const host = await serveFetch(handle);
  t.after(() => host.close());
  return host.url;
}

describe("createSyncHandler", () => {
  it("registers, accepts batches and serves catch-up under any prefix", async () => {
    const h = setup();
    const registration = await h.post("clients", {});
    assert.equal(registration.status, 201);
    assert.equal(registration.headers.get("Cache-Control"), "no-store");
    const registered: unknown = await registration.json();
    assert.ok(typeof registered === "object" && registered !== null && "clientId" in registered && "snapshot" in registered);
    const { clientId } = registered;
    assert.equal(typeof clientId, "string");
    assert.equal(decodeSnapshot(Board, registered.snapshot).serverSeq, 0);
    const accepted = await h.post("batches", batch(String(clientId), 1));
    assert.equal(accepted.status, 204);
    assert.equal((await h.post("batches", batch(String(clientId), 1))).status, 204, "an identical retry replays");
    const commits: unknown = await (await h.get("commits?since=0")).json();
    assert.ok(Array.isArray(commits));
    assert.deepEqual(commits.map((commit) => decodeServerCommit(Board, commit).serverSeq), [1]);
    assert.deepEqual(await (await h.get("commits?since=1")).json(), []);
  });

  it("checks numeric options: TypeError for a non-number, RangeError for a bad number", async () => {
    const server = createServer(Board);
    for (const name of ["maxBodySize", "heartbeatInterval", "maxEventStreams"] as const) {
      assert.throws(() => createSyncHandler(Board, server, { [name]: -1 }), RangeError, name);
      assert.throws(() => createSyncHandler(Board, server, { [name]: 1.5 }), RangeError, name);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A wrong type on purpose.
      assert.throws(() => createSyncHandler(Board, server, { [name]: "1" as unknown as number }), TypeError, name);
    }
    const transport = createHttpTransport({ url: "http://sync.test/", fetch: () => Promise.reject(new Error("unused")) });
    for (const options of [{ pollInterval: -1 }, { pushTimeout: 0.5 }, { retry: { initialDelay: -1 } }, { retry: { maxDelay: Infinity } }]) {
      await assert.rejects(connectSync(Board, { transport, ...options }), RangeError, JSON.stringify(options));
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A wrong type on purpose.
    await assert.rejects(connectSync(Board, { transport, pollInterval: "1" as unknown as number }), TypeError);
  });

  it("rejects invalid requests with fixed messages and no echo", async () => {
    const h = setup({ maxBodySize: 256 });
    const clientId = h.server.openClient();
    const cases: [Promise<Response>, number][] = [
      [h.get("unknown"), 404],
      [h.get("rejections"), 404],
      [h.get("clients"), 405],
      [h.post("commits", {}), 405],
      [h.get("commits"), 400],
      [h.get("commits?since=-1"), 400],
      [h.get("commits?since=01"), 400],
      [h.get("commits?since=1&since=2"), 400],
      [h.get("commits?since=5"), 400],
      [h.post("batches", batch(clientId, 1), { "Content-Type": "text/plain" }), 415],
      [h.post("batches", "{<script>"), 400],
      [h.post("batches", { clientId, seq: 1, operations: [{ type: "evil", path: "<script>" }] }), 400],
      [h.post("clients", { extra: true }), 400],
      [h.post("batches", { clientId, seq: 1, operations: [{ type: "value/set", path: "count", value: "x".repeat(300) }] }), 413],
      [h.post("batches", batch(clientId, 3)), 409],
      [h.post("batches", batch("client-99", 1)), 409],
    ];
    for (const [response, status] of cases) {
      const result = await response;
      assert.equal(result.status, status);
      const body = await result.text();
      assert.ok(!body.includes("<script>") && !body.includes("evil"), body);
    }
    const wrongMethod = await h.handle(new Request(base + "batches", { method: "PUT" }));
    assert.equal(wrongMethod.headers.get("Allow"), "POST");
    assert.equal(h.server.snapshot().serverSeq, 0);
  });

  it("enables rejections only on request and asks authorize with the batch's writer", async () => {
    const asked: { action: SyncAction; clientId?: string }[] = [];
    const h = setup({ allowRejections: true, authorize: (_request, context) => { asked.push(context); return context.clientId !== "client-2"; } });
    const a = h.server.openClient(), b = h.server.openClient();
    assert.equal((await h.post("rejections", batch(a, 1))).status, 204);
    assert.equal((await h.post("batches", batch(b, 1))).status, 403);
    await h.get("commits?since=0");
    await h.post("clients", {});
    assert.deepEqual(asked, [
      { action: "reject", clientId: a }, { action: "submit", clientId: b }, { action: "catchUp" }, { action: "register" },
    ]);
    assert.deepEqual(h.server.snapshot().data.count, 0, "the rejection committed nothing");
  });

  it("saves before answering, serves no unsaved commit and fails closed when saving fails", async () => {
    const saves: number[] = [];
    let release: (() => void) | undefined;
    let failNext = false;
    const h = setup({ async saveCheckpoint(checkpoint: ServerCheckpoint<Shape>) {
      saves.push(checkpoint.snapshot.serverSeq);
      if (checkpoint.snapshot.serverSeq === 1) await new Promise<void>((resolve) => { release = resolve; });
      if (failNext) throw new Error("disk full");
    } });
    const clientId = h.server.openClient();
    const submitted = h.post("batches", batch(clientId, 1));
    await new Promise((resolve) => setImmediate(resolve));
    const catchUp = h.get("commits?since=0");
    let served = false;
    void catchUp.then(() => { served = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(served, false, "catch-up waits for the pending save");
    release!();
    assert.equal((await submitted).status, 204);
    const served1: unknown = await (await catchUp).json();
    assert.ok(Array.isArray(served1) && served1.length === 1);
    failNext = true;
    assert.equal((await h.post("batches", batch(clientId, 2))).status, 500);
    assert.equal((await h.get("commits?since=0")).status, 503);
    assert.equal((await h.post("clients", {})).status, 503);
    assert.deepEqual(saves, [1, 2]);
  });

  it("keeps two connectSync writers converged over real HTTP and maps statuses to retryability", async (t: TestContext) => {
    const server = createServer(Board);
    let outage = false;
    const handle = createSyncHandler(Board, server);
    const url = await serve(t, async (request) => {
      if (outage) return new Response("down", { status: 503 });
      if (request.headers.get("authorization") === "bad") return new Response("no", { status: 401 });
      return handle(request);
    });
    const a = await connectSync(Board, { transport: createHttpTransport({ url }), pollInterval: 0, retry: { initialDelay: 60_000 } });
    const b = await connectSync(Board, { transport: createHttpTransport({ url: new URL(url) }), pollInterval: 0 });
    a.doc.state.items.push("from A");
    b.doc.state.items.push("from B");
    assert.equal(await a.sync(), true);
    assert.equal(await b.sync(), true);
    assert.equal(await a.sync(), true);
    assert.deepEqual(a.doc.state.items.toArray(), b.doc.state.items.toArray());
    assert.equal(a.doc.state.items.length, 2);

    outage = true;
    a.doc.state.count.value = 1;
    assert.equal(await a.sync(), false);
    assert.equal(a.status, "retrying");
    outage = false;
    assert.equal(await a.sync(), true);

    const denied = await connectSync(Board, { pollInterval: 0,
      transport: createHttpTransport({ url, headers: () => ({ authorization: "bad" }) }), checkpoint: b.doc.checkpoint() });
    await assert.rejects(denied.sync(), (error) => error instanceof SyncRequestError && error.status === 401 && !error.retryable);
    assert.equal(denied.status, "failed");
    for (const client of [a, b]) client.close();
  });

  it("runs the documented example: a lost response is acknowledged, not duplicated, then pushed", async () => {
    const result = await runSyncAdapterDemo();
    assert.deepEqual([...result.items].sort(), ["Pushed to A", "Written by A", "Written by B"]);
    assert.equal(result.serverSeq, 3);
  });
});

/** Collects a stream's events in the background. */
function listen(response: Response) {
  const events: ServerSentEvent[] = [];
  let pings = 0;
  assert.ok(response.body !== null);
  const done = readServerSentEvents(response.body, (event) => events.push(event), () => { pings++; });
  return { events, done, get activity() { return pings; },
    sequences: () => events.filter((event) => event.type === "commits").flatMap((event) => {
      const commits: unknown = JSON.parse(event.data);
      assert.ok(Array.isArray(commits));
      return commits.map((commit) => decodeServerCommit(Board, commit).serverSeq);
    }) };
}
const settle = async () => { for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve)); };

describe("createSyncHandler event streams", () => {
  it("limits queued UTF-8 bytes and closes only the stream that falls behind", async (t) => {
    // Keep clearInterval real so callbacks from previous HTTP tests can still clean up.
    const heartbeat = t.mock.method(globalThis, "setInterval");
    const saves: number[] = [];
    const h = setup({ maxEventStreams: 2, heartbeatInterval: 60_000, maxBodySize: 5 * 1024 * 1024,
      saveCheckpoint: (checkpoint) => { saves.push(checkpoint.snapshot.serverSeq); } });
    const slow = await h.get("events?since=0");
    assert.equal(slow.status, 200);
    t.after(async () => { if (!slow.body?.locked) await slow.body?.cancel(); });
    const abort = new AbortController();
    const fast = listen(await h.handle(new Request(base + "events?since=0", { signal: abort.signal })));
    t.after(async () => { abort.abort(); await fast.done; });

    const writer = h.server.openClient();
    const emptyFrame = `event: commits\nid: 1\ndata: ${JSON.stringify([{
      serverSeq: 1, source: { clientId: writer, seq: 1 }, operations: insert(writer, "").operations,
    }])}\n\n`;
    const bytes = 4 * 1024 * 1024;
    const payloadBytes = bytes - Buffer.byteLength(emptyFrame);
    const payload = "😀".repeat(Math.floor(payloadBytes / 4)) + "x".repeat(payloadBytes % 4);
    assert.equal((await h.post("batches", insert(writer, payload))).status, 204);
    await settle();
    assert.deepEqual(fast.sequences(), [1]);

    assert.equal(heartbeat.mock.callCount(), 2);
    for (const { arguments: [ping] } of heartbeat.mock.calls) ping();
    const full = await h.get("events?since=1");
    t.after(() => full.body?.cancel());
    assert.equal(full.status, 503, "a skipped heartbeat does not release the slow reader's slot");

    assert.equal((await h.post("batches", batch(writer, 2))).status, 204);
    const resumed = await h.get("events?since=2");
    t.after(() => resumed.body?.cancel());
    assert.equal(resumed.status, 200, "overflow releases the slot before the slow reader drains");
    const queued = await slow.text();
    assert.equal(Buffer.byteLength(queued), bytes);
    assert.ok(queued.startsWith("event: commits\nid: 1\n"));
    assert.ok(queued.endsWith("\n\n"));
    assert.ok(!queued.includes(": ping\n"));

    assert.equal((await h.post("batches", batch(writer, 3))).status, 204);
    await settle();
    assert.deepEqual(fast.sequences(), [1, 2, 3]);
    assert.deepEqual(saves, [1, 2, 3]);
    const commits: unknown = await (await h.get("commits?since=1")).json();
    assert.ok(Array.isArray(commits));
    assert.deepEqual(commits.map((commit) => decodeServerCommit(Board, commit).serverSeq), [2, 3]);
  });

  it("admits concurrent event streams one at a time within the capacity limit", async (t) => {
    const h = setup({ maxEventStreams: 1, heartbeatInterval: 0 });
    const before = h.server.checkpoint();
    const responses = await Promise.all([h.get("events?since=0"), h.get("events?since=0")]);
    t.after(async () => { for (const response of responses) await response.body?.cancel(); });
    assert.deepEqual(responses.map((response) => response.status), [200, 503]);
    assert.deepEqual(h.server.checkpoint(), before);
    await responses[0].body?.cancel();
    const replacement = await h.get("events?since=0");
    t.after(() => replacement.body?.cancel());
    assert.equal(replacement.status, 200, "closing the admitted stream releases its slot");
  });

  it("keeps event streams disabled when their capacity is zero", async (t) => {
    const heartbeat = t.mock.method(globalThis, "setInterval");
    const h = setup({ maxEventStreams: 0 });
    const responses = await Promise.all([h.get("events?since=0"), h.get("events?since=0")]);
    assert.deepEqual(responses.map((response) => response.status), [503, 503]);
    for (const response of responses) await response.body?.cancel();
    assert.equal(heartbeat.mock.callCount(), 0);
  });

  for (const stage of ["before", "authorization", "queued-save"] as const) it(`does not retain an event stream aborted ${stage}`, async (t) => {
    const heartbeat = t.mock.method(globalThis, "setInterval");
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const abort = new AbortController();
    let authorizeFirst = true;
    const h = setup({ maxEventStreams: 1, heartbeatInterval: 1000,
      async authorize(_request, context) {
        if (stage === "authorization" && context.action === "catchUp" && authorizeFirst) {
          authorizeFirst = false; entered.resolve(); await gate.promise;
        }
        return true;
      },
      async saveCheckpoint() {
        if (stage === "queued-save") { entered.resolve(); await gate.promise; }
      },
    });
    t.after(() => { abort.abort(); gate.resolve(); });
    let submitted: Promise<Response> | undefined;
    if (stage === "queued-save") {
      submitted = h.post("batches", batch(h.server.openClient(), 1));
      await entered.promise;
    }
    if (stage === "before") abort.abort();
    const pending = h.handle(new Request(base + "events?since=0", { signal: abort.signal }));
    if (stage === "authorization") await entered.promise;
    if (stage === "queued-save") {
      let answered = false;
      void pending.then(() => { answered = true; });
      await settle();
      assert.equal(answered, false, "stream creation waits for the pending save");
    }
    abort.abort(); gate.resolve();
    if (submitted !== undefined) assert.equal((await submitted).status, 204);
    const response = await pending;
    t.after(() => response.body?.cancel());
    assert.equal(response.status, 200);
    assert.equal(heartbeat.mock.callCount(), 0, "an aborted request starts no heartbeat");
    const replacement = await h.get("events?since=0");
    t.after(() => replacement.body?.cancel());
    assert.equal(replacement.status, 200, "the aborted request occupies no stream slot");
    const reader = response.body!.getReader();
    try { assert.deepEqual(await reader.read(), { done: true, value: undefined }); }
    finally { reader.releaseLock(); }
    assert.equal(heartbeat.mock.callCount(), 1, "only the live replacement starts a heartbeat");
  });

  it("releases a cancelled reader's slot and ignores its later abort", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = setup({ maxEventStreams: 1, heartbeatInterval: 1000 });
    const abort = new AbortController();
    const first = await h.handle(new Request(base + "events?since=0", { signal: abort.signal }));
    await first.body?.cancel();
    abort.abort();
    const replacement = await h.get("events?since=0");
    t.after(() => replacement.body?.cancel());
    assert.equal(replacement.status, 200);
    const excess = await h.get("events?since=0");
    assert.equal(excess.status, 503, "late cleanup does not free another stream's slot");
    await excess.body?.cancel();
    t.mock.timers.tick(1000);
    const reader = replacement.body!.getReader();
    try {
      const chunk = await reader.read();
      assert.equal(new TextDecoder().decode(chunk.value), ": ping\n\n");
      await reader.cancel();
    } finally { reader.releaseLock(); }
    t.mock.timers.tick(10_000);
  });

  it("sends saved commits after the watermark, then each new commit only once it is saved", async () => {
    let release: (() => void) | undefined;
    const h = setup({ async saveCheckpoint(checkpoint) {
      if (checkpoint.snapshot.serverSeq === 3) await new Promise<void>((resolve) => { release = resolve; });
    } });
    const clientId = h.server.openClient();
    for (const seq of [1, 2]) assert.equal((await h.post("batches", batch(clientId, seq))).status, 204);
    const abort = new AbortController();
    const response = await h.handle(new Request(base + "events?since=1", { signal: abort.signal }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const stream = listen(response);
    await settle();
    assert.deepEqual(stream.sequences(), [2]);
    assert.equal(stream.events[0]?.id, "2");
    const third = h.post("batches", batch(clientId, 3));
    await settle();
    assert.deepEqual(stream.sequences(), [2], "nothing is pushed while its checkpoint is still saving");
    release!();
    assert.equal((await third).status, 204);
    await settle();
    assert.deepEqual(stream.sequences(), [2, 3]);
    abort.abort();
    await stream.done;
  });

  it("resumes after Last-Event-ID, reports gaps, validates and limits streams", async () => {
    const h = setup({ maxEventStreams: 1, authorize: (request) => request.headers.get("x-deny") === null });
    const server = createServer(Board, { maxHistory: 1 });
    const narrow = createSyncHandler(Board, server);
    const clientId = h.server.openClient();
    for (const seq of [1, 2, 3]) await h.post("batches", batch(clientId, seq));
    const abort = new AbortController();
    const resumed = listen(await h.handle(new Request(base + "events?since=0", { signal: abort.signal, headers: { "Last-Event-ID": "2" } })));
    await settle();
    assert.deepEqual(resumed.sequences(), [3]);
    assert.equal((await h.get("events?since=0")).status, 503, "one stream at a time here");
    abort.abort();
    await resumed.done;
    await settle();
    const statuses = await Promise.all([
      h.get("events"), h.get("events?since=-1"), h.get("events?since=9"),
      h.handle(new Request(base + "events?since=0", { headers: { "x-deny": "1" } })),
      h.handle(new Request(base + "events?since=0", { method: "POST" })),
    ]);
    assert.deepEqual(statuses.map((response) => response.status), [400, 400, 400, 403, 405]);

    const other = server.openClient();
    for (const seq of [1, 2]) server.receive(batch(other, seq));
    const gap = listen(await narrow(new Request(base + "events?since=0")));
    await gap.done;
    assert.deepEqual(gap.events.map((event) => event.type), ["gap"], "the stream ends after a gap");
  });

  it("sends heartbeats, pushes commits made outside the handler on notify() and closes streams when saving fails", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let failSave = false;
    const h = setup({ heartbeatInterval: 1000, saveCheckpoint() { if (failSave) throw new Error("disk full"); } });
    const stream = listen(await h.get("events?since=0"));
    await settle();
    const before = stream.activity;
    t.mock.timers.tick(1000); await settle();
    t.mock.timers.tick(1000); await settle();
    assert.equal(stream.activity, before + 4, "two comment lines and their blank lines");
    const clientId = h.server.openClient();
    h.server.receive(batch(clientId, 1)); // Outside the handler.
    await settle();
    assert.deepEqual(stream.sequences(), []);
    await h.handle.notify();
    await settle();
    assert.deepEqual(stream.sequences(), [1]);
    failSave = true;
    assert.equal((await h.post("batches", batch(clientId, 2))).status, 500);
    await stream.done;
    assert.equal((await h.get("events?since=0")).status, 503);
  });
});

/** Waits for `condition` using real timers. */
async function until(condition: () => boolean, what: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("push over real HTTP", () => {
  it("catches up over HTTP after an oversized initial push and resumes live delivery", async (t) => {
    const h = setup({ heartbeatInterval: 0 });
    const eventsSince: string[] = [], commitsSince: string[] = [];
    const writer = h.server.openClient();
    const large = "😀".repeat(1024 * 1024);
    const url = await serve(t, (request) => {
      const { pathname, searchParams } = new URL(request.url);
      const since = searchParams.get("since") ?? "";
      if (pathname.endsWith("/commits")) commitsSince.push(since);
      if (pathname.endsWith("/events")) {
        eventsSince.push(since);
        if (eventsSince.length === 1) {
          // A new saved commit lands between the first catch-up and the push subscription.
          h.server.receive(insert(writer, large));
          h.server.receive(batch(writer, 2, 20));
        }
      }
      return h.handle(request);
    });
    const a = await connectSync(Board, {
      transport: createHttpTransport({ url }), pollInterval: 0, retry: { initialDelay: 20, maxDelay: 100 },
    });
    t.after(() => a.close());
    const applied: number[] = [];
    a.doc.on("change", (event) => {
      if (event.origin === "server") applied.push(event.commit.serverSeq);
    });
    assert.equal(await a.sync(), true);
    await until(() => a.push === "open" && eventsSince.at(-1) === "2", "catch-up and reconnection");
    assert.deepEqual(eventsSince, ["0", "2"]);
    assert.ok(commitsSince.filter((since) => since === "0").length >= 2);
    assert.deepEqual(applied, [1, 2]);
    assert.deepEqual(a.doc.state.items.toArray(), [large]);
    assert.equal(a.doc.state.count.value, 20);

    h.server.receive(batch(writer, 3, 30));
    await h.handle.notify();
    await until(() => a.doc.state.count.value === 30, "the next pushed commit");
    assert.deepEqual(applied, [1, 2, 3]);
    a.doc.state.count.value = 40;
    assert.equal(await a.sync(), true);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
    assert.deepEqual(a.doc.checkpoint().snapshot, h.server.snapshot());
  });

  it("delivers commits without polling and reconnects after the server restarts", async (t: TestContext) => {
    const server = createServer(Board);
    let host = await serveFetch(createSyncHandler(Board, server, { heartbeatInterval: 200 }));
    const port = Number(new URL(host.url).port);
    t.after(() => host.close());
    let catchUps = 0;
    const counting: typeof fetch = async (input, init) => {
      if ((input instanceof Request ? input.url : input.toString()).includes("/commits?")) catchUps++;
      return fetch(input, init);
    };
    const a = await connectSync(Board, { pollInterval: 0, pushTimeout: 2000, retry: { initialDelay: 20, maxDelay: 100 },
      transport: createHttpTransport({ url: host.url, fetch: counting }) });
    const b = await connectSync(Board, { pollInterval: 0, push: false, transport: createHttpTransport({ url: host.url }) });
    t.after(() => { a.close(); b.close(); });
    await a.sync();
    await until(() => a.push === "open", "the push channel");
    const before = catchUps;
    b.doc.state.items.push("live");
    await b.sync();
    await until(() => a.doc.state.items.length === 1, "the pushed commit");
    assert.equal(catchUps, before, "delivered by push alone");

    await host.close();
    await until(() => a.push !== "open", "the channel to drop");
    host = await serveFetch(createSyncHandler(Board, server, { heartbeatInterval: 200 }), port);
    await until(() => a.push === "open", "reconnection");
    b.doc.state.items.push("after restart");
    await b.sync();
    await until(() => a.doc.state.items.length === 2, "the commit after restart");
    assert.deepEqual(a.doc.state.items.toArray(), b.doc.state.items.toArray());
  });
});

describe("Node Fetch bridge", () => {
  for (const disconnect of [false, true]) {
    it(`waits for ${disconnect ? "disconnect" : "drain"} before pulling again after a backed-up write`, async (t) => {
      const blocked = Promise.withResolvers<ServerResponse>();
      const cancelled = Promise.withResolvers<void>();
      const encoder = new TextEncoder();
      const chunks = ["first", "second"];
      let pulls = 0;
      const bridge = toNodeListener(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[pulls++];
          assert.ok(chunk !== undefined);
          controller.enqueue(encoder.encode(chunk));
          if (pulls === chunks.length) controller.close();
        },
        cancel() { cancelled.resolve(); },
      }, { highWaterMark: 0 })));
      const server = createHttpServer((request, response) => {
        const write = response.write.bind(response);
        let writes = 0;
        t.mock.method(response, "write", (chunk: Uint8Array) => {
          const ready = write(chunk);
          if (++writes === 1) { blocked.resolve(response); return false; }
          return ready;
        });
        bridge(request, response);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      t.after(() => new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }));
      const address = server.address();
      assert.ok(address !== null && typeof address !== "string");
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      t.after(async () => { if (!response.body?.locked) await response.body?.cancel().catch(() => {}); });
      const outgoing = await blocked.promise;
      await settle();
      assert.equal(pulls, 1);
      assert.equal(outgoing.listenerCount("drain"), 1);
      if (disconnect) {
        outgoing.destroy();
        await cancelled.promise;
        assert.equal(pulls, 1);
      } else {
        outgoing.emit("drain");
        assert.equal(await response.text(), "firstsecond");
        assert.equal(pulls, 2);
      }
      assert.equal(outgoing.listenerCount("drain"), 0);
    });
  }
});
