import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import { connectHttpExampleClient, startHttpExampleServer } from "../examples/http-sync.ts";
import { createCheckpointStore } from "../examples/persistent-resume.ts";
import { Board } from "../examples/resume.ts";
import { createServer, type ClientDocument, type CreateServerOptions } from "../src/index.ts";

type Shape = typeof Board.definition;
type Store = ReturnType<typeof createCheckpointStore>;
type HostOptions = NonNullable<Parameters<typeof startHttpExampleServer>[1]>;
const httpUrl = new URL("../examples/http-sync.ts", import.meta.url).href;
const storeUrl = new URL("../examples/persistent-resume.ts", import.meta.url).href;

function directory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "articula-persistent-http-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

async function boot(t: TestContext, store: Store, options: CreateServerOptions<Shape> = {}, hostOptions: HostOptions = {}) {
  const checkpoint = store.loadServer();
  const server = createServer(Board, { ...options, ...(checkpoint === null ? {} : { checkpoint }) });
  const host = await startHttpExampleServer(server, { saveServerCheckpoint: store.saveServer, ...hostOptions });
  t.after(() => host.close());
  return { server, host };
}

async function connect(url: string, clientId: string, store: Store) {
  const checkpoint = store.loadClient(clientId);
  return connectHttpExampleClient(url, clientId, {
    ...(checkpoint === null ? {} : { checkpoint }), saveClientCheckpoint: store.saveClient,
  });
}

function batch(clientId = "peer", seq = 1) {
  return { clientId, seq, operations: [{ type: "value/set", path: "count", value: seq }] };
}

async function post(url: string, input: unknown): Promise<Response> {
  return fetch(url + "/batches", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}

function converged(store: Store, server: ReturnType<typeof createServer<Shape>>, ...docs: ClientDocument<Shape>[]): void {
  assert.deepEqual(store.loadServer(), server.checkpoint());
  for (const doc of docs) {
    const checkpoint = doc.checkpoint();
    assert.deepEqual(checkpoint.pendingBatches, []);
    assert.deepEqual(checkpoint.snapshot, server.snapshot());
    assert.deepEqual(store.loadClient(checkpoint.clientId), checkpoint);
  }
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function child(t: TestContext, code: string): Promise<void> {
  const processChild = spawn(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", code]);
  t.after(async () => {
    if (processChild.exitCode !== null || processChild.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => processChild.once("close", () => resolve()));
    processChild.kill();
    await closed;
  });
  let stdout = "";
  let stderr = "";
  processChild.stdout.setEncoding("utf8").on("data", (message: string) => { stdout += message; });
  processChild.stderr.setEncoding("utf8").on("data", (message: string) => { stderr += message; });
  const status = await new Promise<number | null>((resolve, reject) => {
    processChild.once("error", reject);
    processChild.once("close", resolve);
  });
  assert.equal(status, 0, stderr);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
}

describe("file-backed HTTP recovery example", { timeout: 15_000 }, () => {
  it("imports without demo side effects and disallows asynchronous saving callbacks", async (t) => {
    const url = new URL("../examples/persistent-http-sync.ts", import.meta.url).href;
    await child(t, "await import(" + JSON.stringify(url) + ")");
    if (false) {
      await startHttpExampleServer(createServer(Board), {
        // @ts-expect-error Saving must complete synchronously before serving the state.
        saveServerCheckpoint: async () => {},
      });
      await connectHttpExampleClient("http://127.0.0.1", "a", {
        // @ts-expect-error Saving must complete synchronously before submission.
        saveClientCheckpoint: async () => {},
      });
    }
  });

  it("saves and restores mixed tombstones, pending work, sequences and allocation counters", async (t) => {
    const store = createCheckpointStore(directory(t));
    const original = await boot(t, store);
    const a = await connect(original.host.url, "a", store);
    const b = await connect(original.host.url, "b", store);
    a.doc.transact(() => { a.doc.state.items.push("Seed"); a.doc.state.body.insert(0, "A😀"); });
    assert.equal(await a.sync(), true);
    a.doc.transact(() => { a.doc.state.items.delete(0); a.doc.state.body.delete(0, 2); });
    assert.equal(await a.sync(), true);
    assert.equal(await b.sync(), true);
    a.doc.transact(() => {
      a.doc.state.count.value = 3;
      a.doc.state.items.push("Pending");
      a.doc.state.body.insert(0, "😀");
    });
    a.doc.state.count.value = 4;
    const saved = store.loadClient("a")!;
    assert.deepEqual(saved.pendingBatches.map((entry) => entry.seq), [3, 4]);
    assert.ok(saved.snapshot.data.items.idList.some((range) => range.isDeleted));
    assert.ok(saved.snapshot.data.body.idList.some((range) => range.isDeleted));
    await original.host.close();

    const restored = await boot(t, store);
    const source = await connect(restored.host.url, "a", store);
    const peer = await connect(restored.host.url, "b", store);
    assert.deepEqual(source.doc.checkpoint(), saved);
    source.doc.transact(() => {
      source.doc.state.items.insert(0, "Restored");
      source.doc.state.body.insert(0, "R");
    });
    const next = store.loadClient("a")!.pendingBatches.at(-1)!;
    assert.equal(next.seq, 5);
    for (const operation of next.operations) {
      assert.ok(operation.type === "list/insert" || operation.type === "text/insert");
      assert.equal(JSON.parse(operation.id.bunchId)[2], saved.lastBunchSeqs[operation.path] + 1);
    }
    assert.equal(await source.sync(), true);
    assert.equal(await peer.sync(), true);
    converged(store, restored.server, source.doc, peer.doc);
    assert.deepEqual(peer.doc.state.items.toArray(), ["Restored", "Pending"]);
    assert.equal(peer.doc.state.body.toString(), "R😀");
  });

  it("persists local pending before a child exits without syncing", async (t) => {
    const path = directory(t);
    const store = createCheckpointStore(path);
    const { server, host } = await boot(t, store);
    const code = [
      "import { connectHttpExampleClient } from " + JSON.stringify(httpUrl),
      "import { createCheckpointStore } from " + JSON.stringify(storeUrl),
      "const store = createCheckpointStore(" + JSON.stringify(path) + ")",
      "const client = await connectHttpExampleClient(" + JSON.stringify(host.url) + ", 'child', { saveClientCheckpoint: store.saveClient })",
      "client.doc.transact(() => { client.doc.state.count.value = 7; client.doc.state.items.push('Child'); client.doc.state.body.insert(0, '😀'); })",
      "process.exit(0)",
    ].join(";\n");
    await child(t, code);
    assert.equal(server.snapshot().serverSeq, 0);
    assert.equal(store.loadClient("child")!.pendingBatches.length, 1);
    const restored = await connect(host.url, "child", store);
    assert.equal(await restored.sync(), true);
    converged(store, server, restored.doc);
  });

  it("recovers a saved server result with a lost POST response without resolving it again", async (t) => {
    const store = createCheckpointStore(directory(t));
    const resolved: number[] = [];
    const options: CreateServerOptions<Shape> = { resolve: ({ batch }) => {
      resolved.push(batch.seq); return batch.operations;
    } };
    const original = await boot(t, store, options);
    const failure = new Error("Response lost after saving");
    const source = await connectHttpExampleClient(original.host.url, "a", {
      saveClientCheckpoint: store.saveClient, fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === "POST") {
          await response.text();
          assert.deepEqual(store.loadServer(), original.server.checkpoint());
          throw failure;
        }
        return response;
      },
    });
    await connect(original.host.url, "b", store);
    source.doc.state.count.value = 1;
    source.doc.state.items.push("Unsent");
    await assert.rejects(source.sync(), (error: unknown) => error === failure);
    assert.equal(store.loadClient("a")!.pendingBatches.length, 2);
    assert.equal(store.loadServer()!.snapshot.serverSeq, 1);
    await original.host.close();
    const restored = await boot(t, store, options);
    const a = await connect(restored.host.url, "a", store);
    const b = await connect(restored.host.url, "b", store);
    assert.equal(await a.sync(), true);
    assert.equal(await b.sync(), true);
    assert.deepEqual(resolved, [1, 2]);
    converged(store, restored.server, a.doc, b.doc);
  });

  it("saves policy outcomes before 204, saves silent acks and does not rewrite valid retries", async (t) => {
    for (const mode of ["accept", "reject", "transform"] as const) {
      const store = createCheckpointStore(directory(t));
      let saves = 0;
      let resolves = 0;
      const { server, host } = await boot(t, store, { resolve: ({ batch }) => {
        resolves++;
        return mode === "accept" ? batch.operations : mode === "reject" ? []
          : [{ type: "value/set", path: "count", value: 5 }];
      } }, { saveServerCheckpoint: (checkpoint) => { saves++; store.saveServer(checkpoint); } });
      const a = await connectHttpExampleClient(host.url, "a", { saveClientCheckpoint: store.saveClient,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (init?.method === "POST") assert.deepEqual(store.loadServer(), server.checkpoint());
          return response;
        },
      });
      let serverChanges = 0;
      a.doc.on("change", (event) => { if (event.origin === "server") serverChanges++; });
      a.doc.transact(() => {
        a.doc.state.count.value = 1; a.doc.state.items.push("Policy"); a.doc.state.body.insert(0, "😀");
      });
      const pending = store.loadClient("a")!.pendingBatches[0]!;
      assert.equal(await a.sync(), true);
      assert.equal(serverChanges, mode === "accept" ? 0 : 1);
      assert.equal(a.doc.state.count.value, mode === "accept" ? 1 : mode === "reject" ? 0 : 5);
      assert.equal(saves, 2); // Initial checkpoint plus this new result.
      const retry = await post(host.url, pending);
      await retry.text();
      assert.equal(retry.status, 204);
      assert.equal(saves, 2);
      assert.equal(resolves, 1);
      converged(store, server, a.doc);
    }
  });

  it("rejects initial saving failures without listening or returning a client handle", async (t) => {
    const failure = new Error("Initial saving failed");
    const server = createServer(Board);
    await assert.rejects(startHttpExampleServer(server, { saveServerCheckpoint: () => { throw failure; } }),
      (error: unknown) => error === failure);
    const store = createCheckpointStore(directory(t));
    const { host } = await boot(t, store);
    await assert.rejects(connectHttpExampleClient(host.url, "a", {
      saveClientCheckpoint: () => { throw failure; },
    }), (error: unknown) => error === failure);
    assert.equal(server.snapshot().serverSeq, 0);
    assert.equal(store.loadClient("a"), null);
  });

  it("does not submit locally unsaved work and can recover the last successfully saved pending", async (t) => {
    const store = createCheckpointStore(directory(t));
    const { server, host } = await boot(t, store);
    const failure = new Error("Local save failed");
    const a = await connectHttpExampleClient(host.url, "a", { saveClientCheckpoint: (checkpoint) => {
      if (checkpoint.lastLocalSeq === 2) throw failure;
      store.saveClient(checkpoint);
    } });
    a.doc.state.count.value = 1;
    assert.throws(() => a.doc.state.items.push("Unsaved"), (error: unknown) => error === failure);
    assert.deepEqual(a.doc.checkpoint().pendingBatches.map((entry) => entry.seq), [1, 2]);
    assert.deepEqual(store.loadClient("a")!.pendingBatches.map((entry) => entry.seq), [1]);
    await assert.rejects(a.sync(), (error: unknown) => error === failure);
    assert.equal(server.snapshot().serverSeq, 0);
    const restored = await connect(host.url, "a", store);
    assert.equal(await restored.sync(), true);
    assert.deepEqual(restored.doc.state.items.toArray(), []); // Unsaved edits are not claimed recoverable.
    converged(store, server, restored.doc);
  });

  it("keeps the first save error during an in-flight request and stops before applying or posting", async (t) => {
    for (const mode of ["response", "fetch-error"] as const) {
      const store = createCheckpointStore(directory(t));
      const { server, host } = await boot(t, store);
      const remote = await post(host.url, batch());
      await remote.text();
      const entered = gate();
      const release = gate();
      t.after(() => release.resolve());
      const failure = new Error("Saving failed while fetching");
      let posts = 0;
      const responses: Response[] = [];
      const a = await connectHttpExampleClient(host.url, "a", {
        // Restore a saved client at watermark zero so the paused response has work to apply.
        checkpoint: { clientId: "a", snapshot: createServer(Board).snapshot(), lastLocalSeq: 0,
          pendingBatches: [], lastBunchSeqs: { items: 0, body: 0 } },
        saveClientCheckpoint: (checkpoint) => {
          if (checkpoint.lastLocalSeq === 2) throw failure;
          store.saveClient(checkpoint);
        },
        fetch: async (input, init) => {
          if (init?.method === "POST") posts++;
          const response = await fetch(input, init);
          responses.push(response);
          entered.resolve();
          await release.promise;
          if (mode === "fetch-error") { await response.text(); throw new Error("Later fetch failure"); }
          return response;
        },
      });
      a.doc.state.count.value = 10;
      const syncing = a.sync();
      void syncing.catch(() => {});
      try {
        await entered.promise;
        assert.throws(() => a.doc.state.items.push("Unsaved"), (error: unknown) => error === failure);
      } finally { release.resolve(); }
      await assert.rejects(syncing, (error: unknown) => error === failure);
      await assert.rejects(a.sync(), (error: unknown) => error === failure);
      assert.equal(a.doc.checkpoint().snapshot.serverSeq, 0);
      assert.equal(posts, 0);
      assert.ok(responses.every((response) => response.bodyUsed));
      assert.equal(server.snapshot().serverSeq, 1);
      const restored = await connect(host.url, "a", store);
      assert.equal(await restored.sync(), true);
      converged(store, server, restored.doc);
    }
  });

  it("cannot recall an accepted in-flight POST when a later local save fails", async (t) => {
    const store = createCheckpointStore(directory(t));
    let resolves = 0;
    const { server, host } = await boot(t, store, { resolve: ({ batch }) => { resolves++; return batch.operations; } });
    const entered = gate();
    const release = gate();
    t.after(() => release.resolve());
    const failure = new Error("Later local save failed");
    const a = await connectHttpExampleClient(host.url, "a", {
      saveClientCheckpoint: (checkpoint) => {
        if (checkpoint.lastLocalSeq === 2) throw failure;
        store.saveClient(checkpoint);
      },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === "POST") { entered.resolve(); await release.promise; }
        return response;
      },
    });
    a.doc.state.count.value = 1;
    const syncing = a.sync();
    void syncing.catch(() => {});
    try {
      await entered.promise;
      assert.equal(store.loadServer()!.snapshot.serverSeq, 1);
      assert.throws(() => a.doc.state.items.push("Unsaved"), (error: unknown) => error === failure);
    } finally { release.resolve(); }
    await assert.rejects(syncing, (error: unknown) => error === failure);
    assert.equal(a.doc.checkpoint().snapshot.serverSeq, 0);
    assert.equal(store.loadClient("a")!.pendingBatches.length, 1);
    const restored = await connect(host.url, "a", store);
    assert.equal(await restored.sync(), true);
    assert.equal(resolves, 1);
    converged(store, server, restored.doc);
  });

  it("stops a host after server save failure, including a request already reading its body", async (t) => {
    const store = createCheckpointStore(directory(t));
    const failure = new Error("Private storage failure");
    let saves = 0;
    const { server, host } = await boot(t, store, {}, { saveServerCheckpoint: (checkpoint) => {
      saves++;
      if (checkpoint.snapshot.serverSeq > 0) throw failure;
      store.saveServer(checkpoint);
    } });
    const a = await connect(host.url, "a", store);
    a.doc.state.count.value = 1;
    const message = JSON.stringify(batch("slow"));
    let request!: ReturnType<typeof httpRequest>;
    const result = new Promise<number>((resolve, reject) => {
      request = httpRequest(host.url + "/batches", { method: "POST", headers: {
        "Content-Type": "application/json", "Expect": "100-continue",
      } }, (response) => {
        response.resume();
        response.on("error", reject);
        response.on("end", () => resolve(response.statusCode!));
      });
      request.on("error", reject);
    });
    void result.catch(() => {});
    t.after(() => request.destroy());
    const reading = new Promise<void>((resolve) => request.once("continue", resolve));
    request.flushHeaders();
    await reading;
    request.write(message.slice(0, 10));
    const failed = await post(host.url, store.loadClient("a")!.pendingBatches[0]);
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "Checkpoint could not be saved" });
    request.end(message.slice(10));
    assert.equal(await result, 503);
    for (const path of ["/snapshot", "/commits?since=0", "/unknown"]) {
      const response = await fetch(host.url + path);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "Checkpoint storage failed; restart this host" });
    }
    const later = await post(host.url, batch("later"));
    await later.text();
    assert.equal(later.status, 503);
    assert.equal(saves, 2);
    assert.equal(server.snapshot().serverSeq, 1);
    assert.equal(store.loadServer()!.snapshot.serverSeq, 0);
    await host.close();
    const restored = await boot(t, store);
    const source = await connect(restored.host.url, "a", store);
    assert.equal(await source.sync(), true);
    converged(store, restored.server, source.doc);
  });

  it("does not disable a persistent host after resolver or validation errors", async (t) => {
    const store = createCheckpointStore(directory(t));
    let reject = true;
    let saves = 0;
    const { server, host } = await boot(t, store, { resolve: ({ batch }) => {
      if (reject) throw new Error("Resolver failed");
      return batch.operations;
    } }, { saveServerCheckpoint: (checkpoint) => { saves++; store.saveServer(checkpoint); } });
    const first = await post(host.url, batch());
    await first.text();
    assert.equal(first.status, 409);
    reject = false;
    const invalid = await post(host.url, batch("peer", 2));
    await invalid.text();
    assert.equal(invalid.status, 409);
    assert.equal(saves, 1);
    const accepted = await post(host.url, batch());
    await accepted.text();
    assert.equal(accepted.status, 204);
    assert.equal(saves, 2);
    assert.deepEqual(store.loadServer(), server.checkpoint());
  });

  it("recovers a silent ack applied before its client checkpoint save failed", async (t) => {
    const store = createCheckpointStore(directory(t));
    let resolves = 0;
    const { server, host } = await boot(t, store, { resolve: ({ batch }) => { resolves++; return batch.operations; } });
    const failure = new Error("Ack saving failed");
    const a = await connectHttpExampleClient(host.url, "a", { saveClientCheckpoint: (checkpoint) => {
      if (checkpoint.snapshot.serverSeq === 1) throw failure;
      store.saveClient(checkpoint);
    } });
    let serverChanges = 0;
    a.doc.on("change", (event) => { if (event.origin === "server") serverChanges++; });
    a.doc.state.count.value = 1;
    await assert.rejects(a.sync(), (error: unknown) => error === failure);
    assert.equal(serverChanges, 0);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
    assert.equal(store.loadClient("a")!.pendingBatches.length, 1);
    assert.equal(store.loadServer()!.snapshot.serverSeq, 1);
    const restored = await connect(host.url, "a", store);
    assert.equal(await restored.sync(), true);
    assert.equal(resolves, 1);
    converged(store, server, restored.doc);
  });

  it("saves listener mutations behind older pending and saves every applied commit", async (t) => {
    const store = createCheckpointStore(directory(t));
    const resolved: string[] = [];
    const { server, host } = await boot(t, store, { resolve: ({ batch }) => {
      resolved.push(batch.clientId + ":" + batch.seq); return batch.operations;
    } });
    const a = await connect(host.url, "a", store);
    a.doc.state.count.value = 1;
    a.doc.state.count.value = 2;
    const peer = await connect(host.url, "b", store);
    peer.doc.state.items.push("Remote");
    assert.equal(await peer.sync(), true);
    let edited = false;
    a.doc.on("change", (event) => {
      if (event.origin !== "server" || edited) return;
      edited = true;
      a.doc.transact(() => { a.doc.state.items.push("Listener"); a.doc.state.body.insert(0, "😀"); });
      assert.deepEqual(store.loadClient("a")!.pendingBatches.map((entry) => entry.seq), [1, 2, 3]);
    });
    assert.equal(await a.sync(), true);
    assert.equal(await peer.sync(), true);
    assert.deepEqual(resolved, ["b:1", "a:1", "a:2", "a:3"]);
    converged(store, server, a.doc, peer.doc);
  });

  it("does not attempt an extra save after an incoming listener throws", async (t) => {
    const store = createCheckpointStore(directory(t));
    const { server, host } = await boot(t, store);
    let saves = 0;
    const a = await connectHttpExampleClient(host.url, "a", { saveClientCheckpoint: (checkpoint) => {
      saves++;
      if (checkpoint.snapshot.serverSeq > 0) throw new Error("Do not mask the listener error");
      store.saveClient(checkpoint);
    } });
    a.doc.state.count.value = 1;
    const peer = await connect(host.url, "b", store);
    peer.doc.state.items.push("Remote");
    assert.equal(await peer.sync(), true);
    const failure = new Error("Incoming listener failed");
    a.doc.on("change", (event) => { if (event.origin === "server") throw failure; });
    await assert.rejects(a.sync(), (error: unknown) => error === failure);
    await assert.rejects(a.sync(), (error: unknown) => error === failure);
    assert.equal(saves, 2); // Initial and local only; no receive-finally save.
    assert.equal(a.doc.checkpoint().snapshot.serverSeq, 1);
    assert.equal(store.loadClient("a")!.snapshot.serverSeq, 0);
    const restored = await connect(host.url, "a", store);
    assert.equal(await restored.sync(), true);
    assert.equal(await peer.sync(), true);
    converged(store, server, restored.doc, peer.doc);
  });

  it("keeps saved pending intact when history cannot fill the gap", async (t) => {
    const store = createCheckpointStore(directory(t));
    const { host } = await boot(t, store, { historyLimit: 0 });
    const a = await connect(host.url, "a", store);
    a.doc.state.items.push("Pending");
    const before = store.loadClient("a");
    const remote = await post(host.url, batch());
    await remote.text();
    assert.equal(await a.sync(), false);
    assert.equal(await a.sync(), false);
    assert.deepEqual(store.loadClient("a"), before);
    await host.close();
    const restored = await boot(t, store);
    const source = await connect(restored.host.url, "a", store);
    assert.equal(await source.sync(), false);
    assert.deepEqual(store.loadClient("a"), before);
    assert.equal(restored.server.snapshot().serverSeq, 1);
  });
});
