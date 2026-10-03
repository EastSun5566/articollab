import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import { connectHttpExampleClient, startHttpExampleServer } from "../examples/http-sync.ts";
import { createCheckpointStore } from "../examples/persistent-resume.ts";
import { Board } from "../examples/resume.ts";
import { createServer, type ClientCheckpoint, type ServerDocument, type ServerResolver } from "../src/index.ts";

type Shape = typeof Board.definition;
type HostOptions = NonNullable<Parameters<typeof startHttpExampleServer>[1]>;

async function host(t: TestContext, server: ServerDocument<Shape>, options: HostOptions = {}) {
  const result = await startHttpExampleServer(server, options);
  t.after(() => result.close());
  return result;
}

function batch(clientId = "a", seq = 1, value = 1) {
  return { clientId, seq, operations: [{ type: "value/set", path: "count", value }] };
}

async function post(url: string, route: string, input: unknown): Promise<number> {
  const response = await fetch(url + route, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  await response.text();
  return response.status;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("HTTP pending rejection recovery", { timeout: 15_000 }, () => {
  it("imports the demo without opening a socket or printing", async (t) => {
    const url = new URL("../examples/http-reject-pending.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e",
      "await import(" + JSON.stringify(url) + ")"]);
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill();
      await closed;
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(status, 0, stderr);
    assert.equal(stdout + stderr, "");
  });

  it("cancels blocked mixed work, including replayable batches, and resumes editing", async (t) => {
    let resolves = 0;
    const server = createServer(Board, { resolve: ({ batch }) => {
      resolves++;
      return batch.seq === 1 ? [] : batch.operations;
    } });
    const { url } = await host(t, server);
    const a = await connectHttpExampleClient(url, "a");
    const peer = await connectHttpExampleClient(url, "peer");
    a.doc.transact(() => {
      a.doc.state.count.value = 1;
      a.doc.state.items.push("A");
      a.doc.state.body.insert(0, "😀");
    });
    a.doc.transact(() => { a.doc.state.items.push("B"); a.doc.state.body.insert(1, "B"); });
    a.doc.state.count.value = 9;
    assert.equal(await a.sync(), false);
    assert.equal(a.doc.replayConflict?.batch.seq, 2);
    assert.equal(await a.rejectPending(), true);
    assert.equal(a.doc.replayConflict, null);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
    assert.equal(resolves, 1);
    assert.deepEqual(server.snapshot().data, { count: 0, items: { idList: [], values: [] },
      body: { idList: [], value: "" } });
    assert.ok(server.commitsSince(0)!.every((commit) => commit.operations.length === 0));
    a.doc.transact(() => {
      a.doc.state.count.value = 2;
      a.doc.state.items.push("Recovered");
      a.doc.state.body.insert(0, "Hi 😀");
    });
    assert.equal(a.doc.checkpoint().pendingBatches[0]!.seq, 4);
    assert.equal(await a.sync(), true);
    assert.equal(await peer.sync(), true);
    assert.deepEqual(a.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
  });

  it("catches multiple accepted and transformed results before cancelling unsent work", async (t) => {
    let resolves = 0;
    const server = createServer(Board, { resolve: ({ batch }) => {
      resolves++;
      return batch.seq === 2 ? [{ type: "value/set", path: "count", value: 20 }] : batch.operations;
    } });
    const { url } = await host(t, server);
    const rejected: number[] = [];
    const a = await connectHttpExampleClient(url, "a", { fetch: async (input, init) => {
      if (String(input).endsWith("/rejections")) {
        rejected.push(JSON.parse(String(init!.body)).seq);
        // A remote commit races the rejection after the initial catch-up response.
        assert.equal(await post(url, "/batches", { clientId: "peer", seq: 1, operations: [
          { type: "list/insert", path: "items", before: null, id: { bunchId: "peer-list", counter: 0 }, value: "Peer" },
        ] }), 204);
      }
      return fetch(input, init);
    } });
    a.doc.state.count.value = 1;
    a.doc.state.count.value = 2;
    a.doc.state.count.value = 99;
    const pending = a.doc.checkpoint().pendingBatches;
    for (const entry of pending.slice(0, 2)) assert.equal(await post(url, "/batches", entry), 204);
    assert.equal(await a.rejectPending(), true);
    assert.deepEqual(rejected, [3]);
    assert.equal(resolves, 3);
    assert.equal(a.doc.state.count.value, 20);
    assert.deepEqual(a.doc.state.items.toArray(), ["Peer"]);
    assert.deepEqual(a.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(server.commitsSince(0)!.map((commit) => commit.operations.length), [1, 1, 1, 0]);
  });

  it("captures the cutoff before catch-up and retains listener-created higher sequences", async (t) => {
    const server = createServer(Board);
    const { url } = await host(t, server);
    const a = await connectHttpExampleClient(url, "a");
    a.doc.state.items.push("A");
    a.doc.on("change", (event) => {
      if (event.origin !== "server") return;
      if (event.commit.source.clientId === "peer") a.doc.state.count.value = 7;
      if (event.commit.source.clientId === "a") a.doc.state.count.value = 8;
    });
    assert.equal(await post(url, "/batches", { clientId: "peer", seq: 1, operations: [
      { type: "list/insert", path: "items", before: null, id: { bunchId: "peer-list", counter: 0 }, value: "Peer" },
    ] }), 204);
    assert.equal(await a.rejectPending(), true);
    assert.deepEqual(a.doc.checkpoint().pendingBatches.map((entry) => entry.seq), [2, 3]);
    assert.equal(a.doc.state.count.value, 8);
    assert.equal(server.snapshot().serverSeq, 2);
    assert.equal(await a.sync(), true);
  });

  it("keeps a new dependent listener batch even when cancellation blocks it", async (t) => {
    const server = createServer(Board);
    const { url } = await host(t, server);
    const a = await connectHttpExampleClient(url, "a");
    a.doc.state.items.push("A");
    assert.equal(await post(url, "/batches", batch("peer")), 204);
    const guards: Promise<void>[] = [];
    a.doc.on("change", (event) => {
      if (event.origin !== "server" || event.commit.source.clientId !== "peer") return;
      a.doc.state.items.push("B");
      guards.push(assert.rejects(a.sync(), /concurrently or reentrantly/));
      guards.push(assert.rejects(a.rejectPending(), /concurrently or reentrantly/));
    });
    assert.equal(await a.rejectPending(), true);
    await Promise.all(guards);
    assert.equal(a.doc.replayConflict?.batch.seq, 2);
    assert.deepEqual(a.doc.checkpoint().pendingBatches.map((entry) => entry.seq), [2]);
    assert.equal(await a.sync(), false);
    assert.equal(await a.rejectPending(), true);
    assert.equal(a.doc.replayConflict, null);
  });

  it("shares the concurrent guard without poisoning the active operation", async (t) => {
    for (const action of ["sync", "rejectPending"] as const) {
      const server = createServer(Board);
      const { url } = await host(t, server);
      const entered = gate();
      const release = gate();
      t.after(() => release.resolve());
      let hold = true;
      const a = await connectHttpExampleClient(url, "a", { fetch: async (input, init) => {
        if (hold && String(input).includes("/commits?")) {
          hold = false;
          entered.resolve();
          await release.promise;
        }
        return fetch(input, init);
      } });
      a.doc.state.count.value = 1;
      const active = a[action]();
      try {
        await entered.promise;
        a.doc.state.count.value = 2; // Created during the first await, outside the cancellation cutoff.
        await assert.rejects(a.sync(), /concurrently or reentrantly/);
        await assert.rejects(a.rejectPending(), /concurrently or reentrantly/);
      } finally { release.resolve(); }
      assert.equal(await active, true);
      assert.deepEqual(a.doc.checkpoint().pendingBatches.map((entry) => entry.seq), action === "rejectPending" ? [2] : []);
      assert.equal(await a.sync(), true);
      assert.equal(await a.rejectPending(), true);
    }
  });

  it("saves silent rejection acknowledgements and continues through all pending", async (t) => {
    const server = createServer(Board);
    const { url } = await host(t, server);
    const saves: ClientCheckpoint<Shape>[] = [];
    const a = await connectHttpExampleClient(url, "a", { saveClientCheckpoint: (entry) => { saves.push(entry); } });
    let changes = 0;
    a.doc.on("change", (event) => { if (event.origin === "server") changes++; });
    a.doc.state.count.value = 0;
    a.doc.state.count.value = 0;
    assert.equal(await a.rejectPending(), true);
    assert.equal(changes, 0);
    assert.equal(saves.length, 5); // Initial + two local + two silent own acks.
    assert.deepEqual(saves.at(-1), a.doc.checkpoint());
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
  });

  it("does not cancel or replace pending when retained history is insufficient", async (t) => {
    const server = createServer(Board, { historyLimit: 0 });
    const { url } = await host(t, server);
    let posts = 0;
    const a = await connectHttpExampleClient(url, "a", { fetch: async (input, init) => {
      if (init?.method === "POST") posts++;
      return fetch(input, init);
    } });
    a.doc.state.count.value = 2;
    const saved = a.doc.checkpoint();
    assert.equal(await post(url, "/batches", batch("peer")), 204);
    assert.equal(await a.rejectPending(), false);
    assert.equal(await a.sync(), false);
    assert.equal(await a.rejectPending(), false);
    assert.equal(posts, 0);
    assert.deepEqual(a.doc.checkpoint(), saved);
    assert.equal(server.snapshot().serverSeq, 1);
  });

  it("validates the rejection endpoint and shares immutable cross-entrypoint retry results", async (t) => {
    let resolves = 0;
    const saves: number[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => { resolves++; return batch.operations; } });
    const { url } = await host(t, server, { saveServerCheckpoint: (entry) => { saves.push(entry.snapshot.serverSeq); } });
    for (const [init, status] of [
      [{ method: "GET" }, 405],
      [{ method: "POST", body: "{}" }, 415],
      [{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }, 400],
      [{ method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(1024 * 1024 + 1) }, 413],
    ] as const) {
      const response = await fetch(url + "/rejections", init);
      assert.equal(response.status, status);
      assert.equal(typeof (await response.json() as { error: string }).error, "string");
    }
    assert.equal(await post(url, "/rejections", { ...batch(), operations: [{ type: "value/set", path: "items", value: 1 }] }), 400);
    assert.equal(await post(url, "/rejections", batch("a", 2)), 409);
    assert.equal(server.snapshot().serverSeq, 0);
    const invalidState = { clientId: "a", seq: 1, operations: [
      { type: "list/insert", path: "items", before: { bunchId: "unknown", counter: 0 },
        id: { bunchId: "new", counter: 0 }, value: "A" },
      { type: "text/delete", path: "body", ranges: [{ start: { bunchId: "unknown", counter: 0 }, count: 1 }] },
    ] };
    assert.equal(await post(url, "/batches", invalidState), 409);
    assert.equal(await post(url, "/rejections", invalidState), 204);
    assert.equal(await post(url, "/batches", invalidState), 204);
    assert.equal(await post(url, "/rejections", invalidState), 204);
    assert.equal(await post(url, "/rejections", batch()), 409); // Same sequence, different original payload.
    assert.equal(await post(url, "/batches", batch("b")), 204);
    assert.equal(await post(url, "/rejections", batch("b")), 204);
    assert.deepEqual(saves, [0, 1, 2]);
    assert.equal(resolves, 2); // Failed stateful receive + the accepted b batch; reject/retry skip it.
    assert.equal(server.snapshot().data.count, 1);
    assert.deepEqual(server.commitsSince(0)!.map((entry) => entry.operations.length), [0, 1]);
  });

  it("stops on malformed, out-of-order, unacknowledged or listener-failed catch-up", async (t) => {
    for (const fault of ["malformed", "order", "no-ack", "listener"] as const) {
      const server = createServer(Board);
      const { url } = await host(t, server);
      let posts = 0;
      const a = await connectHttpExampleClient(url, "a", { fetch: async (input, init) => {
        if (init?.method === "POST") posts++;
        const response = await fetch(input, init);
        if (!String(input).includes("/commits?") || fault === "listener") return response;
        await response.text();
        return new Response(fault === "malformed" ? "{" : fault === "no-ack" ? "[]" : JSON.stringify([
          { serverSeq: 2, source: { clientId: "peer", seq: 1 }, operations: [] },
        ]), { status: 200 });
      } });
      a.doc.state.items.push("A");
      a.doc.state.count.value = 2;
      const listenerError = new Error("listener failed");
      if (fault === "listener") a.doc.on("change", (event) => { if (event.origin === "server") throw listenerError; });
      const error = await a.rejectPending().catch((failure: unknown) => failure);
      assert.ok(error instanceof Error);
      if (fault === "listener") assert.equal(error, listenerError);
      if (fault === "no-ack") assert.match(error.message, /without acknowledging/);
      await assert.rejects(a.sync(), (failure: unknown) => failure === error);
      await assert.rejects(a.rejectPending(), (failure: unknown) => failure === error);
      assert.equal(posts, fault === "listener" || fault === "no-ack" ? 1 : 0);
      assert.equal(a.doc.checkpoint().pendingBatches.at(-1)!.seq, 2);
    }
  });

  for (const fault of ["lost-response", "server-save", "client-save"] as const) {
    it("restores saved checkpoints after " + fault + " during cancellation", async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "articula-http-reject-test-"));
      const store = createCheckpointStore(directory);
      const hosts: Awaited<ReturnType<typeof startHttpExampleServer>>[] = [];
      t.after(async () => {
        try { await Promise.all(hosts.map((entry) => entry.close())); }
        finally { rmSync(directory, { recursive: true, force: true }); }
      });
      const failure = new Error(fault);
      let resolves = 0;
      const resolve: ServerResolver<Shape> = ({ batch }) => {
        resolves++;
        return batch.operations;
      };
      const server = createServer(Board, { resolve });
      const original = await startHttpExampleServer(server, { saveServerCheckpoint: (entry) => {
        if (fault === "server-save" && entry.snapshot.serverSeq === 1) throw failure;
        store.saveServer(entry);
      } });
      hosts.push(original);
      const a = await connectHttpExampleClient(original.url, "a", {
        saveClientCheckpoint: (entry) => {
          if (fault === "client-save" && entry.snapshot.serverSeq === 1) throw failure;
          store.saveClient(entry);
        },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (fault === "lost-response" && String(input).endsWith("/rejections")) {
            await response.text();
            throw failure;
          }
          return response;
        },
      });
      await connectHttpExampleClient(original.url, "peer", { saveClientCheckpoint: store.saveClient });
      a.doc.transact(() => { a.doc.state.items.push("A"); a.doc.state.body.insert(0, "😀"); });
      a.doc.state.count.value = 9;
      const error = await a.rejectPending().catch((entry: unknown) => entry);
      assert.ok(error instanceof Error);
      if (fault !== "server-save") assert.equal(error, failure);
      assert.deepEqual(store.loadClient("a")!.pendingBatches.map((entry) => entry.seq), [1, 2]);
      assert.equal(store.loadServer()!.snapshot.serverSeq, fault === "server-save" ? 0 : 1);
      assert.equal(server.snapshot().serverSeq, 1);
      await assert.rejects(a.sync(), (entry: unknown) => entry === error);
      if (fault === "server-save") {
        const response = await fetch(original.url + "/snapshot");
        assert.equal(response.status, 503);
        await response.text();
      }
      await original.close(); // Retire all old writers before loading official files.
      const restored = createServer(Board, { checkpoint: store.loadServer()!, resolve });
      const nextHost = await startHttpExampleServer(restored, { saveServerCheckpoint: store.saveServer });
      hosts.push(nextHost);
      const source = await connectHttpExampleClient(nextHost.url, "a", {
        checkpoint: store.loadClient("a")!, saveClientCheckpoint: store.saveClient,
      });
      const peer = await connectHttpExampleClient(nextHost.url, "peer", {
        checkpoint: store.loadClient("peer")!, saveClientCheckpoint: store.saveClient,
      });
      assert.equal(await source.rejectPending(), true);
      assert.equal(resolves, 0); // Confirmed rejection is never resolved or re-submitted.
      assert.equal(restored.snapshot().serverSeq, 2);
      assert.deepEqual(store.loadServer(), restored.checkpoint());
      assert.deepEqual(store.loadClient("a"), source.doc.checkpoint());
      source.doc.transact(() => {
        source.doc.state.count.value = 3;
        source.doc.state.items.push("Recovered");
        source.doc.state.body.insert(0, "Hi 😀");
      });
      assert.equal(source.doc.checkpoint().pendingBatches[0]!.seq, 3);
      assert.equal(await source.sync(), true);
      assert.equal(await peer.sync(), true);
      assert.equal(resolves, 1);
      for (const { doc } of [source, peer]) {
        assert.deepEqual(doc.checkpoint().snapshot, restored.snapshot());
        assert.deepEqual(store.loadClient(doc.checkpoint().clientId), doc.checkpoint());
      }
    });
  }
});
