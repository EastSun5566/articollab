import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { createServer, defineDocument, list, PayloadValidationError, type StandardSchemaV1 } from "../src/index.ts";
import {
  connectSync, createHttpTransport, createSyncHandler,
  type PresenceSyncClient, type SyncHandlerOptions,
} from "../src/sync/index.ts";

const Board = defineDocument({ items: list<string>() });
type Shape = typeof Board.definition;
type State = { readonly name: string };
const base = "http://sync.test/api/";

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

function setup(t: TestContext, options: SyncHandlerOptions<Shape> = { presence: { schema: named } }) {
  const server = createServer(Board);
  const handle = createSyncHandler(Board, server, options);
  const streams = new Set<AbortController>();
  /** In-process fetch; `drop()` cuts every open event stream, as a network loss would. */
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const abort = new AbortController();
    init?.signal?.addEventListener("abort", () => { abort.abort(); });
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/events")) streams.add(abort);
    return handle(new Request(input, { ...init, signal: abort.signal }));
  };
  const clients: { stop(): void }[] = [];
  t.after(() => { for (const client of clients) client.stop(); for (const abort of streams) abort.abort(); });
  async function writer(presence: { republishInterval?: number; schema?: StandardSchemaV1<State> } = {}): Promise<PresenceSyncClient<Shape, State>> {
    const sync = await connectSync(Board, {
      pollInterval: 0, retry: { initialDelay: 20, maxDelay: 50 },
      transport: createHttpTransport({ url: base, fetch }),
      presence: { schema: named, ...presence },
    });
    clients.push(sync);
    await sync.sync();
    await until(() => sync.push === "open", "the push channel");
    return sync;
  }
  const post = (body: unknown) => handle(new Request(base + "presence", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { server, handle, writer, post, drop() { for (const abort of streams) abort.abort(); streams.clear(); } };
}
const names = (sync: PresenceSyncClient<Shape, State>) => [...sync.presence.peers.values()].map(({ name }) => name).sort();

describe("Presence over the sync channel", () => {
  it("shares, updates and clears each writer's state with the others, never with itself", async (t) => {
    const { writer } = setup(t);
    const a = await writer(), b = await writer();
    const changes: string[][] = [];
    b.presence.on("change", (peers) => { changes.push([...peers.values()].map(({ name }) => name)); });
    a.presence.set({ name: "Ann" });
    await until(() => names(b).includes("Ann"), "B to see A");
    assert.deepEqual([names(a), a.presence.state], [[], { name: "Ann" }], "a writer does not see itself");
    a.presence.set({ name: "Ann (editing)" });
    await until(() => names(b).includes("Ann (editing)"), "B to see A's update");
    b.presence.set({ name: "Ben" });
    await until(() => names(a).includes("Ben"), "A to see B");
    a.presence.set(null);
    await until(() => names(b).length === 0, "B to see A leave");
    assert.deepEqual(changes, [["Ann"], ["Ann (editing)"], []]);
    b.stop();
    await until(() => names(a).length === 0, "A to see B leave on stop");
  });

  it("sends a new stream everyone's state, and rebuilds after the stream is lost", async (t) => {
    const fixture = setup(t);
    const a = await fixture.writer();
    a.presence.set({ name: "Ann" });
    const c = await fixture.writer();
    await until(() => names(c).includes("Ann"), "a late writer to see A");
    let cleared = false;
    // Peers are cleared as soon as the stream is lost, before any reconnection.
    c.on("push", (state) => { if (state === "off") cleared = c.presence.peers.size === 0; });
    fixture.drop();
    await until(() => cleared, "C to clear peers when its stream is lost");
    await until(() => c.push === "open" && names(c).includes("Ann"), "C to rebuild after reconnecting");
  });

  it("expires a state that is not sent again within the TTL, and keeps one that is", async (t) => {
    const { writer } = setup(t, { presence: { schema: named, ttl: 150 } });
    const quiet = await writer({ republishInterval: 60_000 });
    const lively = await writer({ republishInterval: 40 });
    const watcher = await writer();
    quiet.presence.set({ name: "quiet" });
    lively.presence.set({ name: "lively" });
    await until(() => names(watcher).length === 2, "both states");
    await until(() => !names(watcher).includes("quiet"), "the quiet state to expire");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(names(watcher), ["lively"], "re-sends keep it alive");
  });

  it("validates states on both sides and skips what a peer's schema rejects", async (t) => {
    const fixture = setup(t, { presence: {}, authorize: (_request, { action, clientId }) => action !== "presence" || clientId !== "denied" });
    const a = await fixture.writer();
    assert.throws(() => { a.presence.set({ nickname: "x" } as never); }, PayloadValidationError); // oxlint-disable-line typescript/no-unsafe-type-assertion -- An invalid state on purpose.
    assert.throws(() => { a.presence.set({ name: Number.NaN as never }); }, TypeError); // oxlint-disable-line typescript/no-unsafe-type-assertion -- Not JSON on purpose.
    // This handler has no schema; a peer on another version sends a state A's schema rejects.
    const rogue = fixture.server.openClient(), peer = fixture.server.openClient();
    assert.equal((await fixture.post({ clientId: rogue, state: { nickname: "x" } })).status, 204);
    assert.equal((await fixture.post({ clientId: peer, state: { name: "Rob" } })).status, 204);
    await until(() => names(a).includes("Rob"), "a valid peer state");
    assert.equal(a.presence.peers.size, 1, "the invalid state was skipped");

    const strict = setup(t);
    const session = strict.server.openClient();
    for (const [body, status] of [
      [{ clientId: session, state: { nickname: "x" } }, 400],
      [{ clientId: session }, 400],
      [{ clientId: session, state: { name: "x" }, extra: 1 }, 400],
      [{ clientId: "nobody", state: { name: "x" } }, 409],
    ] as const) assert.equal((await strict.post(body)).status, status, JSON.stringify(body));
    assert.equal((await fixture.post({ clientId: "denied", state: null })).status, 403);
    const disabled = setup(t, {});
    assert.equal((await disabled.post({ clientId: session, state: null })).status, 404);
  });

  it("requires a transport that can publish presence", async () => {
    const server = createServer(Board);
    await assert.rejects(connectSync(Board, {
      presence: {},
      transport: {
        async register() { return { clientId: server.openClient(), snapshot: server.snapshot() }; },
        async submit() {}, async reject() {}, async commitsSince() { return []; },
      },
    }), /publishPresence/);
  });
});
