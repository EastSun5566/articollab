import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import {
  createServer, decodeServerCommit, decodeSnapshot, defineDocument, list, value, type ServerCheckpoint,
} from "../src/index.ts";
import {
  connectSync, createHttpTransport, createSyncHandler, SyncHttpError,
  type SyncAction, type SyncHandlerOptions,
} from "../src/sync/index.ts";
import { runSyncAdapterDemo, serveFetch } from "../examples/sync-adapter.ts";

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
  ({ clientId, seq, operations: [{ type: "value/set", path: "count", value: count }] });

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

  it("rejects invalid requests with fixed messages and no echo", async () => {
    const h = setup({ bodyLimit: 256 });
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
    await assert.rejects(denied.sync(), (error) => error instanceof SyncHttpError && error.status === 401 && !error.retryable);
    assert.equal(denied.status, "failed");
    for (const client of [a, b]) client.stop();
  });

  it("runs the documented example: a lost response is acknowledged, not duplicated", async () => {
    const result = await runSyncAdapterDemo();
    assert.deepEqual([...result.items].sort(), ["Written by A", "Written by B"]);
    assert.equal(result.serverSeq, 2);
  });
});
