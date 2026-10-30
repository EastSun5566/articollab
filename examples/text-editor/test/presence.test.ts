import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createServer } from "../../../src/index.ts";
import { WireDecodeError } from "../../../dist/index.js"; // The class presence.js decodes with.
import { Board } from "../../resume.ts";
import { createPresenceChannel } from "../presence.js";
import { createPresenceRelay } from "../presence-relay.ts";
import { startTextEditorServer } from "../server.ts";

const caret = { anchor: { bunchId: "b", counter: 0 }, bind: "left" } as const;
const selection = { from: caret, to: caret };

const malformed: typeof fetch = async () => new Response(JSON.stringify({ entries: [{ clientId: "x", seq: 1,
  selection: { from: caret, to: { anchor: null, bind: "up" } } }] }), { status: 200 });

async function fixture(t: TestContext, relay = createPresenceRelay()) {
  const host = await startTextEditorServer(createServer(Board), relay);
  t.after(() => host.close());
  async function post(body: string, contentType = "application/json") {
    const response = await fetch(host.url + "/presence", { method: "POST", headers: { "Content-Type": contentType }, body });
    return { status: response.status, body: await response.text() };
  }
  async function entries(): Promise<{ clientId: string; seq: number; selection: unknown }[]> {
    const response = await fetch(host.url + "/presence");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The relay's own response shape, checked by the assertions that use it.
    return ((await response.json()) as { entries: { clientId: string; seq: number; selection: unknown }[] }).entries;
  }
  return { host, post, entries };
}

describe("Presence relay", { timeout: 30_000 }, () => {
  it("keeps the latest valid selection per client in update order", async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await f.entries(), []);
    assert.equal((await f.post(JSON.stringify({ clientId: "client-1", selection }))).status, 204);
    assert.equal((await f.post(JSON.stringify({ clientId: "client-2", selection: null }))).status, 204);
    const moved = { from: { anchor: null, bind: "right" }, to: caret };
    assert.equal((await f.post(JSON.stringify({ clientId: "client-1", selection: moved }))).status, 204);
    assert.deepEqual(await f.entries(), [
      { clientId: "client-2", seq: 2, selection: null },
      { clientId: "client-1", seq: 3, selection: moved },
    ]);
  });

  it("rejects invalid bodies without storing them or echoing input", async (t) => {
    const f = await fixture(t);
    assert.equal((await f.post(JSON.stringify({ clientId: "c", selection }), "text/plain")).status, 415);
    for (const body of ["{", "[]", JSON.stringify({ clientId: "", selection }),
      JSON.stringify({ clientId: "c", selection, extra: 1 }), JSON.stringify({ clientId: "c" }),
      JSON.stringify({ clientId: "x".repeat(129), selection }),
      JSON.stringify({ clientId: "c", selection: { from: caret } }),
      JSON.stringify({ clientId: "c", selection: { from: caret, to: { ...caret, bind: "middle" } } }),
      JSON.stringify({ clientId: "c", selection: { from: caret, to: { anchor: { bunchId: "<b>", counter: -1 }, bind: "left" } } })]) {
      const result = await f.post(body);
      assert.equal(result.status, 400, body);
      assert.deepEqual(JSON.parse(result.body), { error: "Invalid presence JSON or cursor" });
    }
    assert.equal((await f.post(JSON.stringify({ clientId: "c", selection, padding: "x".repeat(5000) }))).status, 413);
    const put = await fetch(f.host.url + "/presence", { method: "PUT", body: "{}" });
    assert.equal(put.status, 405); assert.equal(put.headers.get("Allow"), "GET, POST"); await put.text();
    assert.deepEqual(await f.entries(), []);
    const snapshot = await fetch(f.host.url + "/snapshot");
    assert.equal(snapshot.status, 200, "core routes are unaffected"); await snapshot.text();
  });

  it("expires entries that were not republished within 15 seconds", async (t) => {
    let clock = 1_000_000;
    const f = await fixture(t, createPresenceRelay({ now: () => clock }));
    assert.equal((await f.post(JSON.stringify({ clientId: "idle", selection: null }))).status, 204);
    clock += 10_000;
    assert.equal((await f.post(JSON.stringify({ clientId: "active", selection: null }))).status, 204);
    clock += 5_000;
    assert.deepEqual((await f.entries()).map(({ clientId }) => clientId), ["idle", "active"], "exactly 15 seconds is kept");
    clock += 1;
    assert.deepEqual((await f.entries()).map(({ clientId }) => clientId), ["active"]);
    assert.equal((await f.post(JSON.stringify({ clientId: "idle", selection: null }))).status, 204);
    assert.deepEqual((await f.entries()).map(({ clientId }) => clientId), ["active", "idle"], "republishing restores an entry");
  });

  it("evicts the least recently updated clients beyond 64 entries", async (t) => {
    const f = await fixture(t);
    for (let index = 0; index < 70; index++) {
      assert.equal((await f.post(JSON.stringify({ clientId: `client-${index}`, selection: null }))).status, 204);
    }
    const kept = await f.entries();
    assert.equal(kept.length, 64);
    assert.deepEqual([kept[0]!.clientId, kept.at(-1)!.clientId], ["client-6", "client-69"]);
  });
});

describe("Presence channel", { timeout: 30_000 }, () => {
  it("sends only the newest selection while a request is in flight and polls others' validated cursors", async (t) => {
    const f = await fixture(t);
    const bodies: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: typeof fetch = async (input, init) => {
      if (init?.method === "POST") {
        bodies.push(typeof init.body === "string" ? init.body : "");
        if (bodies.length === 1) await gate;
      }
      return fetch(input, init);
    };
    const own = createPresenceChannel({ url: f.host.url, clientId: "client-1", fetch: slow });
    const first = own.publish(selection);
    void own.publish(null);
    const last = own.publish({ from: { anchor: null, bind: "left" }, to: caret });
    assert.equal(first, last, "one send loop serves every publish");
    release!();
    await last;
    assert.deepEqual(bodies.map((body) => JSON.parse(body) as unknown), [
      { clientId: "client-1", selection },
      { clientId: "client-1", selection: { from: { anchor: null, bind: "left" }, to: caret } },
    ]);
    const other = createPresenceChannel({ url: f.host.url, clientId: "client-2" });
    await other.publish(null);
    const seen = await other.poll();
    assert.equal(seen.length, 1, "a writer never sees its own entry");
    assert.equal(seen[0]!.clientId, "client-1");
    assert.ok(Object.isFrozen(seen[0]!.selection!.from));
    assert.deepEqual(await own.poll(), [{ clientId: "client-2", seq: 3, selection: null }]);
  });

  it("rejects malformed relayed cursors instead of drawing them", async () => {
    await assert.rejects(createPresenceChannel({ url: "http://127.0.0.1:9", clientId: "me", fetch: malformed }).poll(),
      (error) => error instanceof WireDecodeError);
  });
});
