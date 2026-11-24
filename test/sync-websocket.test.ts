import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, type TestContext } from "node:test";
import { WebSocketServer, type RawData } from "ws";

import { createServer, defineDocument, list, PayloadValidationError, type StandardSchemaV1 } from "../src/index.ts";
import {
  connectSync, createHttpTransport, createSyncHandler, createWebSocketTransport, SyncRequestError,
  type PresenceSyncClient, type SyncConnection, type SyncHandler, type SyncHandlerOptions, type SyncSocket,
} from "../src/sync/index.ts";

const Board = defineDocument({ items: list<string>() });
type Shape = typeof Board.definition;
type State = { readonly name: string };

const named: StandardSchemaV1<State> = {
  "~standard": {
    version: 1, vendor: "test",
    validate: (input) => typeof input === "object" && input !== null && !Array.isArray(input) &&
      Object.keys(input).length === 1 && "name" in input && typeof input.name === "string"
      ? { value: input as State } // oxlint-disable-line typescript/no-unsafe-type-assertion -- Checked above.
      : { issues: [{ message: "Expected { name }" }] },
  },
};

/** Waits for `condition` with real timers. */
async function until(condition: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const bytes = (data: RawData) => Array.isArray(data) ? Buffer.concat(data) : data;

/** A handler served over real sockets (node:http + ws) and, for HTTP writers, in-process fetch. */
async function host(t: TestContext, options: SyncHandlerOptions<Shape> = {}, server = createServer(Board)) {
  const handle = createSyncHandler(Board, server, options);
  const http = createHttpServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (incoming, socket, head) => {
    sockets.handleUpgrade(incoming, socket, head, (ws) => {
      const connection = handle.accept(ws, new Request(new URL(incoming.url ?? "/", "http://sync.test")));
      ws.on("message", (data) => { connection.message(bytes(data)); });
      ws.on("close", () => { connection.close(); });
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/sync/socket`; // oxlint-disable-line typescript/no-unsafe-type-assertion -- A TCP listener.
  const clients: { close(): void }[] = [];
  const streams = new Set<AbortController>();
  t.after(async () => {
    for (const client of clients) client.close();
    for (const abort of streams) abort.abort();
    for (const ws of sockets.clients) ws.terminate();
    http.closeAllConnections();
    await new Promise((resolve) => { http.close(resolve); });
  });
  /** In-process fetch for HTTP writers on the same handler. */
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const abort = new AbortController();
    streams.add(abort);
    init?.signal?.addEventListener("abort", () => { abort.abort(); });
    return handle(new Request(input, { ...init, signal: abort.signal }));
  };
  const retry = { initialDelay: 10, maxDelay: 50 };
  async function socketWriter(query = "", presence = true): Promise<PresenceSyncClient<Shape, State>> {
    const sync = await connectSync(Board, {
      pollInterval: 0, retry, transport: createWebSocketTransport({ url: url + query }),
      ...(presence ? { presence: { schema: named } } : { presence: { schema: named, republishInterval: 60_000 } }),
    });
    clients.push(sync);
    await sync.sync();
    await until(() => sync.push === "open", "the socket subscription");
    return sync;
  }
  async function httpWriter(): Promise<PresenceSyncClient<Shape, State>> {
    const sync = await connectSync(Board, {
      pollInterval: 0, retry, transport: createHttpTransport({ url: "http://sync.test/api/", fetch }), presence: { schema: named },
    });
    clients.push(sync);
    await sync.sync();
    await until(() => sync.push === "open", "the event stream");
    return sync;
  }
  return { server, handle, url, sockets, socketWriter, httpWriter };
}

/** Accepts one socket in-process and records what the handler sends. */
function direct(handle: SyncHandler, url = "http://sync.test/socket", bufferedAmount = () => 0) {
  const sent: Record<string, unknown>[] = [];
  let closed: { code?: number; reason?: string } | undefined;
  const socket: SyncSocket = {
    send(message) { sent.push(JSON.parse(message) as Record<string, unknown>); }, // oxlint-disable-line typescript/no-unsafe-type-assertion -- The handler sends objects.
    close(code, reason) { closed = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }; },
    get bufferedAmount() { return bufferedAmount(); },
  };
  const connection: SyncConnection = handle.accept(socket, new Request(url));
  let nextId = 0;
  return {
    connection, sent,
    get closed() { return closed; },
    /** Sends one message and waits for its reply. */
    async ask(message: Record<string, unknown>): Promise<Record<string, unknown>> {
      const id = nextId++;
      connection.message(JSON.stringify({ id, ...message }));
      let reply: Record<string, unknown> | undefined;
      await until(() => (reply = sent.find((entry) => entry.id === id)) !== undefined || closed !== undefined, `reply ${id}`);
      return reply ?? {};
    },
  };
}
const insert = (clientId: string, seq: number, item: string) => ({
  clientId, seq, operations: [{
    type: "list/insert" as const, path: "items" as const, before: null,
    id: { bunchId: JSON.stringify([clientId, "items", seq]), counter: 0 }, value: item,
  }],
});
/** The client ID in a registration reply. */
function clientIdOf(reply: Record<string, unknown>): string {
  const { body } = reply;
  assert.ok(typeof body === "object" && body !== null && "clientId" in body && typeof body.clientId === "string");
  return body.clientId;
}
const items = (sync: { doc: { state: { items: { toArray(): string[] } } } }) => sync.doc.state.items.toArray();

describe("WebSocket transport", () => {
  it("syncs writers over one socket each, pushing commits without polling", async (t) => {
    const h = await host(t);
    const a = await h.socketWriter(), b = await h.socketWriter();
    a.doc.state.items.push("from A");
    await until(() => items(b).includes("from A"), "B to receive A's commit");
    b.doc.state.items.push("from B");
    await until(() => items(a).length === 2 && items(b).length === 2, "both to converge");
    assert.deepEqual(items(a), items(b));
    assert.equal(h.sockets.clients.size, 2, "requests and pushes share one socket per writer");
  });

  it("shares commits and presence between HTTP and WebSocket writers of one handler", async (t) => {
    const h = await host(t, { presence: { schema: named } });
    const overSocket = await h.socketWriter(), overHttp = await h.httpWriter();
    overSocket.doc.state.items.push("socket");
    overHttp.doc.state.items.push("http");
    await until(() => items(overSocket).length === 2 && items(overHttp).length === 2, "both writers to converge");
    overSocket.presence.set({ name: "Sam" });
    overHttp.presence.set({ name: "Hana" });
    await until(() => [...overHttp.presence.peers.values()].some(({ name }) => name === "Sam") &&
      [...overSocket.presence.peers.values()].some(({ name }) => name === "Hana"), "each to see the other");
    assert.throws(() => { overSocket.presence.set({ nickname: "x" } as never); }, PayloadValidationError); // oxlint-disable-line typescript/no-unsafe-type-assertion -- Invalid on purpose.
  });

  it("clears a socket's presence when it drops, before the TTL, and the writer shares it again on reconnect", async (t) => {
    const h = await host(t, { presence: { schema: named, ttl: 60_000 } });
    const watcher = await h.httpWriter();
    const writer = await h.socketWriter();
    writer.presence.set({ name: "Sam" });
    const id = writer.doc.checkpoint().clientId;
    await until(() => watcher.presence.peers.get(id)?.name === "Sam", "the watcher to see Sam");
    let cleared = false;
    watcher.presence.on("change", (peers) => { if (!peers.has(id)) cleared = true; });
    for (const ws of h.sockets.clients) ws.terminate();
    await until(() => cleared, "the dropped socket's presence to clear");
    await until(() => watcher.presence.peers.get(id)?.name === "Sam", "the writer to share it again after reconnecting");
    writer.doc.state.items.push("after reconnect");
    await until(() => items(watcher).includes("after reconnect"), "writes to resume");
  });

  it("answers with HTTP statuses: 403 fails the client, a dropped socket is retried", async (t) => {
    const h = await host(t, { authorize: (request) => new URL(request.url).searchParams.get("token") === "ok" });
    await assert.rejects(connectSync(Board, { transport: createWebSocketTransport({ url: h.url + "?token=no" }) }),
      (error) => error instanceof SyncRequestError && error.status === 403 && !error.retryable);
    const a = await h.socketWriter("?token=ok", false), b = await h.socketWriter("?token=ok", false);
    for (const ws of h.sockets.clients) ws.terminate();
    a.doc.state.items.push("after drop");
    await until(() => items(b).includes("after drop"), "writes to recover after the drop");
    await until(() => a.push === "open" && b.push === "open", "both subscriptions to reopen");
  });

  it("reads a function URL before each connection and closes the socket with the client", async (t) => {
    const h = await host(t);
    let reads = 0;
    const sync = await connectSync(Board, { pollInterval: 0, retry: { initialDelay: 10, maxDelay: 50 },
      transport: createWebSocketTransport({ url: async () => { reads++; return new URL(h.url); } }) });
    await sync.sync();
    await until(() => sync.push === "open", "the subscription");
    assert.equal(reads, 1);
    for (const ws of h.sockets.clients) ws.terminate();
    await until(() => sync.push === "open" && reads === 2, "a reconnect that reads the URL again");
    sync.close();
    await until(() => h.sockets.clients.size === 0, "the socket to close");
    assert.throws(() => createWebSocketTransport({ url: "not a url" }), TypeError);
  });

  it("keeps the transport for the client restartFromSnapshot() returns", async (t) => {
    const h = await host(t, {}, createServer(Board, { maxHistory: 1 }));
    const transport = createWebSocketTransport({ url: h.url });
    const behind = await connectSync(Board, { transport, pollInterval: 0, push: false });
    const writer = await h.socketWriter("", false);
    for (const item of ["a", "b", "c"]) {
      writer.doc.state.items.push(item);
      await writer.sync();
    }
    await behind.sync();
    assert.equal(behind.status, "gap");
    const next = await behind.restartFromSnapshot();
    assert.equal(behind.status, "closed");
    await next.sync();
    assert.deepEqual(items(next), ["a", "b", "c"]);
    next.close();
  });
});

describe("WebSocket transport, scripted", () => {
  it("takes pushes only once its subscribe is answered, since earlier ones belong to a replaced subscription", async () => {
    const sockets: Scripted[] = [];
    class Scripted {
      readonly sent: Record<string, unknown>[] = [];
      private readonly listeners: [string, (event: unknown) => void][] = [];
      constructor() { sockets.push(this); setTimeout(() => { this.emit("open", {}); }); }
      addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.push([type, listener]); }
      emit(type: string, event: unknown) { for (const [name, listener] of this.listeners) if (name === type) listener(event); }
      send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); } // oxlint-disable-line typescript/no-unsafe-type-assertion -- The transport sends objects.
      close() { this.emit("close", {}); }
      receive(message: unknown) { this.emit("message", { data: JSON.stringify(message) }); }
    }
    const transport = createWebSocketTransport({ url: "ws://sync.test/socket", WebSocket: Scripted });
    const seen: string[] = [];
    const end = transport.subscribe?.(0, {
      onOpen: () => { seen.push("open"); }, onCommits: () => { seen.push("commits"); }, onGap: () => { seen.push("gap"); },
      onPresence: () => { seen.push("presence"); }, onActivity: () => { seen.push("ping"); }, onEnd: () => { seen.push("end"); },
    });
    await until(() => sockets[0]?.sent.length === 1, "the subscribe request");
    const socket = sockets[0]!;
    for (const push of [{ type: "commits", commits: [] }, { type: "presence", clientId: "x", state: null }, { type: "gap" }]) socket.receive(push);
    assert.deepEqual(seen, [], "pushes before the reply are ignored");
    socket.receive({ id: socket.sent[0]!.id, status: 200 });
    await until(() => seen.length === 1, "the reply");
    socket.receive({ type: "commits", commits: [] });
    socket.receive({ type: "ping" });
    assert.deepEqual(seen, ["open", "commits", "ping"]);
    end?.();
    await until(() => socket.sent.at(-1)?.type === "unsubscribe", "the unsubscribe");
    transport.close?.();
    assert.deepEqual(seen, ["open", "commits", "ping"], "closing after unsubscribing reports nothing");
  });
});

describe("SyncHandler.accept", () => {
  it("answers each message with its id and the HTTP status, and closes on malformed input", async () => {
    const handle = createSyncHandler(Board, createServer(Board));
    const s = direct(handle);
    const registered = await s.ask({ type: "register" });
    assert.equal(registered.status, 201);
    const clientId = clientIdOf(registered);
    assert.deepEqual(await s.ask({ type: "submit", batch: insert(clientId, 1, "x") }), { id: 1, status: 204 });
    assert.deepEqual((await s.ask({ type: "commits", since: 0 })).status, 200);
    for (const [message, status] of [
      [{ type: "reject", batch: insert(clientId, 2, "y") }, 404],
      [{ type: "presence", clientId, state: null }, 404],
      [{ type: "teleport" }, 404],
      [{ type: "register", extra: 1 }, 400],
      [{ type: "commits", since: -1 }, 400],
      [{ type: "submit", batch: { nope: true } }, 400],
      [{ type: "submit", batch: insert("nobody", 1, "z") }, 409],
    ] as const) assert.equal((await s.ask(message)).status, status, JSON.stringify(message));
    assert.equal(s.closed, undefined);

    for (const [data, code] of [
      ["not json", 1008], [JSON.stringify([1]), 1008], [JSON.stringify({ type: "register" }), 1008],
      [new Uint8Array([0xff, 0xfe]), 1007],
    ] as const) {
      const other = direct(handle);
      other.connection.message(data);
      assert.equal(other.closed?.code, code, String(data));
    }
    const small = createSyncHandler(Board, createServer(Board), { maxBodySize: 32 });
    for (const data of ["x".repeat(33), "é".repeat(17), new TextEncoder().encode("x".repeat(33))]) {
      const other = direct(small);
      other.connection.message(data);
      assert.equal(other.closed?.code, 1009, "over the size limit");
    }
    const fits = direct(small);
    fits.connection.message(new TextEncoder().encode(JSON.stringify({ id: 0, type: "register" })));
    await until(() => fits.sent.length === 1, "a UTF-8 bytes message to be answered");
  });

  it("opens the latest subscribe, replies before pushing, ends on a gap and counts toward maxEventStreams", async () => {
    const server = createServer(Board, { maxHistory: 1 });
    const handle = createSyncHandler(Board, server, { maxEventStreams: 1 });
    const writer = server.openClient();
    server.receive(insert(writer, 1, "a"));
    const s = direct(handle);
    s.connection.message(JSON.stringify({ id: 1, type: "subscribe", since: 0 }));
    s.connection.message(JSON.stringify({ id: 2, type: "subscribe", since: 1 }));
    await until(() => s.sent.some((entry) => entry.id === 1) && s.sent.some((entry) => entry.id === 2), "both replies");
    assert.deepEqual(s.sent.toSorted((x, y) => Number(x.id) - Number(y.id)), [{ id: 1, status: 204 }, { id: 2, status: 200 }],
      "only the latest subscribe opens");
    assert.equal((await direct(handle).ask({ type: "subscribe", since: 1 })).status, 503, "the limit counts sockets");
    server.receive(insert(writer, 2, "b"));
    await handle.notify();
    assert.deepEqual(s.sent.at(-1)?.type, "commits");
    assert.deepEqual(await s.ask({ type: "unsubscribe" }), { id: 0, status: 204 });
    server.receive(insert(writer, 3, "c"));
    await handle.notify();
    assert.equal(s.sent.filter((entry) => entry.type === "commits").length, 1, "nothing after unsubscribe");

    const behind = direct(handle);
    await behind.ask({ type: "subscribe", since: 0 });
    assert.deepEqual(behind.sent, [{ id: 0, status: 200 }, { type: "gap" }], "the reply comes before any push");
    server.receive(insert(writer, 4, "d"));
    await handle.notify();
    assert.deepEqual(behind.sent.at(-1), { type: "gap" }, "a gap ends the subscription");
    assert.equal(behind.closed, undefined, "but not the socket");

    const first = direct(handle);
    assert.equal((await first.ask({ type: "subscribe", since: 4 })).status, 200);
    first.connection.close();
    const second = direct(handle);
    assert.equal((await second.ask({ type: "subscribe", since: 4 })).status, 200, "a closed socket frees its slot");
    second.connection.close();
  });

  it("sends heartbeats, closes a socket whose send queue is full and fails closed when saving fails", async () => {
    const server = createServer(Board);
    let saves = 0;
    const handle = createSyncHandler(Board, server, {
      heartbeatInterval: 10, saveCheckpoint: () => { if (++saves > 1) throw new Error("disk full"); },
    });
    const live = direct(handle);
    await live.ask({ type: "subscribe", since: 0 });
    await until(() => live.sent.some((entry) => entry.type === "ping"), "a heartbeat");
    const idle = direct(handle);
    const registered = await live.ask({ type: "register" });
    assert.equal(registered.status, 201);
    const clientId = clientIdOf(registered);
    await live.ask({ type: "submit", batch: insert(clientId, 1, "x") }); // The second save fails.
    assert.equal(live.closed?.code, 1011, "saving failed");
    assert.equal(idle.closed?.code, 1011, "every socket closes, subscribed or not");
    assert.equal(direct(handle).closed?.code, 1011, "new sockets are refused");
    assert.equal((await handle(new Request("http://sync.test/api/commits?since=0"))).status, 503);

    const fresh = createSyncHandler(Board, createServer(Board), { heartbeatInterval: 0 });
    let full = 0;
    const lagging = direct(fresh, undefined, () => full);
    await lagging.ask({ type: "subscribe", since: 0 });
    full = 5 * 1024 * 1024;
    const other = direct(fresh);
    const id = clientIdOf(await other.ask({ type: "register" }));
    await other.ask({ type: "submit", batch: insert(id, 1, "x") });
    assert.equal(lagging.closed?.code, 1013, "a full send queue closes the socket");
  });

  it("clears a state whose socket closed while authorize was still deciding", async () => {
    const server = createServer(Board);
    let decide = (): void => {};
    const decided = new Promise<void>((resolve) => { decide = resolve; });
    const handle = createSyncHandler(Board, server, { presence: { ttl: 60_000 },
      authorize: async (_request, { action }) => { if (action === "presence") await decided; return true; } });
    const watcher = direct(handle);
    await watcher.ask({ type: "subscribe", since: 0 });
    const clientId = server.openClient();
    const late = direct(handle);
    late.connection.message(JSON.stringify({ id: 0, type: "presence", clientId, state: { name: "late" } }));
    late.connection.close();
    decide();
    const updates = () => watcher.sent.filter((entry) => entry.type === "presence").map((entry) => entry.state);
    await until(() => updates().length === 2, "the late state and its removal");
    assert.deepEqual(updates(), [{ name: "late" }, null]);
    watcher.connection.close();
  });

  it("drops a socket writer's state when server.closeClient() closes its session", async () => {
    const server = createServer(Board);
    const handle = createSyncHandler(Board, server, { presence: { ttl: 60_000 } });
    const watcher = direct(handle);
    await watcher.ask({ type: "subscribe", since: 0 });
    const clientId = server.openClient();
    const writer = direct(handle);
    await writer.ask({ type: "presence", clientId, state: { name: "Sam" } });
    server.closeClient(clientId);
    const updates = () => watcher.sent.filter((entry) => entry.type === "presence").map((entry) => entry.state);
    assert.deepEqual(updates(), [{ name: "Sam" }, null], "removed at once, while the socket is still open");
    writer.connection.close();
    assert.deepEqual(updates(), [{ name: "Sam" }, null], "and the socket closing later changes nothing");
    watcher.connection.close();
  });

  it("clears presence only for the socket that last sent it", async () => {
    const server = createServer(Board);
    const handle = createSyncHandler(Board, server, { presence: { ttl: 60_000 } });
    const watcher = direct(handle);
    await watcher.ask({ type: "subscribe", since: 0 });
    const clientId = server.openClient();
    const first = direct(handle), second = direct(handle);
    await first.ask({ type: "presence", clientId, state: { name: "one" } });
    await second.ask({ type: "presence", clientId, state: { name: "two" } });
    first.connection.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updates = () => watcher.sent.filter((entry) => entry.type === "presence").map((entry) => entry.state);
    assert.deepEqual(updates(), [{ name: "one" }, { name: "two" }], "the older socket closing changes nothing");
    second.connection.close();
    await until(() => updates().length === 3, "the newer socket's close to clear it");
    assert.equal(updates().at(-1), null);
    watcher.connection.close();
  });
});
