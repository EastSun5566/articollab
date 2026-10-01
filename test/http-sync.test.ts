import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { describe, it, type TestContext } from "node:test";

import { connectHttpExampleClient, startHttpExampleServer } from "../examples/http-sync.ts";
import { Board } from "../examples/resume.ts";
import { createServer, type ServerDocument } from "../src/index.ts";

type Shape = typeof Board.definition;
const exampleUrl = new URL("../examples/http-sync.ts", import.meta.url).href;

async function host(t: TestContext, server: ServerDocument<Shape> = createServer(Board)) {
  const result = await startHttpExampleServer(server);
  t.after(() => result.close());
  return result;
}

function batch(clientId = "a", seq = 1, value = 1) {
  return { clientId, seq, operations: [{ type: "value/set", path: "count", value }] };
}

async function post(url: string, input: unknown): Promise<number> {
  const response = await fetch(url + "/batches", {
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

async function child(t: TestContext, code: string): Promise<string> {
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
  assert.equal(stderr, "");
  return stdout;
}

describe("localhost HTTP sync example", { timeout: 15_000 }, () => {
  it("imports without opening a server or running the demo", async (t) => {
    assert.equal(await child(t, "await import(" + JSON.stringify(exampleUrl) + ")"), "");
  });

  it("syncs mixed optimistic work and silent acknowledgements without automatic sending", async (t) => {
    const server = createServer(Board);
    const { url } = await host(t, server);
    const a = await connectHttpExampleClient(url, "a");
    const b = await connectHttpExampleClient(url, "b");
    assert.deepEqual(a.doc.checkpoint().snapshot, server.snapshot());
    let serverChanges = 0;
    a.doc.on("change", (event) => { if (event.origin === "server") serverChanges++; });
    a.doc.transact(() => {
      a.doc.state.count.value = 1;
      a.doc.state.items.push("Saved");
      a.doc.state.body.insert(0, "A😀");
    });
    a.doc.transact(() => {
      a.doc.state.count.value = 2;
      a.doc.state.items.push("Later");
      a.doc.state.body.insert(2, "!");
    });
    assert.deepEqual(a.doc.state.items.toArray(), ["Saved", "Later"]);
    assert.equal(a.doc.state.body.toString(), "A😀!");
    assert.equal(server.snapshot().serverSeq, 0);
    assert.equal(await a.sync(), true);
    assert.equal(serverChanges, 0);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
    assert.equal(b.doc.state.count.value, 0); // No broadcast or background polling.
    assert.equal(await b.sync(), true);
    assert.deepEqual(b.doc.checkpoint().snapshot, server.snapshot());
    b.doc.state.count.value = 3;
    assert.equal(await b.sync(), true);
    assert.equal(await a.sync(), true);
    assert.deepEqual(a.doc.checkpoint().snapshot, server.snapshot());
  });

  it("catches updates between snapshot retrieval and the first sync", async (t) => {
    const server = createServer(Board);
    const { url } = await host(t, server);
    const peer = await connectHttpExampleClient(url, "peer");
    const client = await connectHttpExampleClient(url, "a", { fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).endsWith("/snapshot")) return response;
      const message = await response.text();
      peer.doc.state.items.push("After snapshot");
      assert.equal(await peer.sync(), true);
      return new Response(message, { status: response.status, headers: response.headers });
    } });
    assert.equal(client.doc.checkpoint().snapshot.serverSeq, 0);
    assert.equal(client.doc.state.items.length, 0);
    client.doc.state.count.value = 2;
    assert.equal(await client.sync(), true);
    assert.deepEqual(client.doc.state.items.toArray(), ["After snapshot"]);
    assert.deepEqual(client.doc.checkpoint().snapshot, server.snapshot());
  });

  it("applies missed remote commits before own results, never acknowledging from POST", async (t) => {
    const server = createServer(Board);
    const { url } = await host(t, server);
    const postWatermarks: number[] = [];
    const a = await connectHttpExampleClient(url, "a", { fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === "POST") {
        postWatermarks.push(a.doc.checkpoint().snapshot.serverSeq);
        assert.ok(a.doc.checkpoint().pendingBatches.length > 0);
      }
      return response;
    } });
    const b = await connectHttpExampleClient(url, "b");
    a.doc.state.count.value = 1;
    a.doc.state.count.value = 2;
    b.doc.state.count.value = 8;
    b.doc.state.items.push("Remote");
    assert.equal(await b.sync(), true);
    const sequences: number[] = [];
    const receive = a.doc.receive.bind(a.doc);
    t.mock.method(a.doc, "receive", (commit: Parameters<typeof a.doc.receive>[0]) => {
      sequences.push(commit.serverSeq);
      receive(commit);
    });
    assert.equal(await a.sync(), true);
    assert.deepEqual(sequences, [1, 2, 3, 4]);
    assert.deepEqual(postWatermarks, [2, 3]);
    assert.equal(a.doc.state.count.value, 2);
    assert.deepEqual(a.doc.state.items.toArray(), ["Remote"]);
    assert.equal(await b.sync(), true);
    assert.deepEqual(b.doc.checkpoint().snapshot, a.doc.checkpoint().snapshot);
  });

  it("sends listener-created mutations after older pending batches, including silent acks", async (t) => {
    const seen: string[] = [];
    const server = createServer(Board, { resolve: ({ batch: incoming }) => {
      seen.push(incoming.clientId + ":" + incoming.seq);
      return incoming.clientId === "a" && incoming.seq === 1 ? [] : incoming.operations;
    } });
    const { url } = await host(t, server);
    const a = await connectHttpExampleClient(url, "a");
    a.doc.state.count.value = 10;
    a.doc.state.items.push("Older");
    let changed = false;
    a.doc.on("change", (event) => {
      if (event.origin !== "server" || changed) return;
      changed = true;
      assert.deepEqual(a.doc.checkpoint().pendingBatches.map((entry) => entry.seq), [2]);
      a.doc.transact(() => {
        a.doc.state.count.value = 30;
        a.doc.state.items.push("Listener");
        a.doc.state.body.insert(0, "😀");
      });
    });
    assert.equal(await a.sync(), true);
    assert.deepEqual(seen, ["a:1", "a:2", "a:3"]);
    assert.deepEqual(a.doc.state.items.toArray(), ["Older", "Listener"]);
    assert.equal(a.doc.state.count.value, 30);
    assert.deepEqual(a.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
  });

  it("reconciles policy accept, reject and transform and deduplicates HTTP retries", async (t) => {
    for (const mode of ["accept", "reject", "transform"] as const) {
      let calls = 0;
      const server = createServer(Board, { resolve: ({ batch: incoming }) => {
        calls++;
        if (incoming.seq === 1 || mode === "accept") return incoming.operations;
        return mode === "reject" ? [] : [{ type: "value/set", path: "count", value: 5 }];
      } });
      const { url } = await host(t, server);
      const a = await connectHttpExampleClient(url, "a");
      a.doc.transact(() => {
        a.doc.state.count.value = 1;
        a.doc.state.items.push("Seed");
        a.doc.state.body.insert(0, "😀");
      });
      assert.equal(await a.sync(), true);
      const b = await connectHttpExampleClient(url, "b");
      a.doc.transact(() => {
        a.doc.state.count.value = 10;
        a.doc.state.items.delete(0);
        a.doc.state.body.delete(0);
      });
      assert.equal(await a.sync(), true);
      assert.equal(a.doc.state.count.value, mode === "accept" ? 10 : mode === "reject" ? 1 : 5);
      assert.deepEqual(a.doc.state.items.toArray(), mode === "accept" ? [] : ["Seed"]);
      assert.equal(a.doc.state.body.toString(), mode === "accept" ? "" : "😀");
      a.doc.transact(() => {
        a.doc.state.items.push("New");
        a.doc.state.body.insert(a.doc.state.body.length, "!");
      });
      const retry = a.doc.checkpoint().pendingBatches[0]!;
      assert.equal(await a.sync(), true);
      assert.deepEqual(a.doc.state.items.toArray(), mode === "accept" ? ["New"] : ["Seed"]);
      assert.equal(a.doc.state.body.toString(), mode === "accept" ? "!" : "😀");
      const before = server.checkpoint();
      assert.equal(await post(url, retry), 204);
      assert.equal(calls, 3);
      assert.deepEqual(server.checkpoint(), before);
      assert.equal(await b.sync(), true);
      assert.deepEqual(b.doc.checkpoint().snapshot, a.doc.checkpoint().snapshot);
    }
  });

  it("returns false permanently on a history gap without submitting or replacing pending", async (t) => {
    const server = createServer(Board, { historyLimit: 0 });
    const { url } = await host(t, server);
    let requests = 0;
    const a = await connectHttpExampleClient(url, "a", { fetch: (input, init) => {
      requests++;
      return fetch(input, init);
    } });
    a.doc.state.count.value = 1;
    const before = a.doc.checkpoint();
    assert.equal(await post(url, batch("b")), 204);
    assert.equal(await a.sync(), false);
    assert.equal(await a.sync(), false);
    assert.equal(requests, 2); // Snapshot and one catch-up only.
    assert.deepEqual(a.doc.checkpoint(), before);
    assert.equal(server.snapshot().serverSeq, 1);
  });

  it("rejects invalid routes, methods, JSON, wire data and watermarks without consuming sequence", async (t) => {
    const server = createServer(Board);
    const { url } = await host(t, server);
    const inputs: Array<[string, RequestInit | undefined, number]> = [
      ["/unknown", undefined, 404],
      ["/snapshot", { method: "POST" }, 405],
      ["/batches", undefined, 405],
      ["/commits?since=0", { method: "POST" }, 405],
      ["/batches", { method: "POST", body: "{}" }, 415],
      ["/batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }, 400],
      ["/batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 400],
      ["/batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...batch(), operations: [] }) }, 400],
      ["/batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...batch(), operations: [{ type: "value/set", path: "body", value: 1 }] }) }, 400],
    ];
    for (const since of ["", "?since=", "?since=-1", "?since=1.5", "?since=x", "?since=1e2", "?since=01",
      "?since=9007199254740992", "?since=1", "?since=0&since=0"]) {
      inputs.push(["/commits" + since, undefined, 400]);
    }
    for (const [path, init, status] of inputs) {
      const response = await fetch(url + path, init);
      assert.equal(response.status, status, path);
      const error: unknown = await response.json();
      assert.ok(typeof error === "object" && error !== null && "error" in error);
      assert.deepEqual(Object.keys(error), ["error"]);
      assert.equal(typeof error.error, "string");
      assert.equal(server.snapshot().serverSeq, 0);
    }
    assert.equal(await post(url, batch("a", 2)), 409);
    assert.equal(await post(url, { ...batch(), operations: [{ type: "list/delete", path: "items", id: { bunchId: "unknown", counter: 0 } }] }), 409);
    assert.equal(await post(url, batch()), 204);
    assert.equal(await post(url, batch("a", 1, 99)), 409);
    assert.equal(await post(url, batch("a", 3)), 409);
    assert.equal(await post(url, batch("a", 2, 2)), 204);
    assert.equal(server.snapshot().serverSeq, 2);
  });

  it("counts actual chunked UTF-8 bytes, completes 413 and accepts the exact 1 MiB boundary", async (t) => {
    const server = createServer(Board);
    const { url } = await host(t, server);
    const oversized = JSON.stringify(batch("a", 1, 1)).replace('"value":1', '"value":"' + "😀".repeat(270_000) + '"');
    assert.ok(oversized.length < 1024 * 1024);
    assert.ok(Buffer.byteLength(oversized) > 1024 * 1024);
    const bytes = Buffer.from(oversized);
    const result = await new Promise<{ status: number; message: string }>((resolve, reject) => {
      const request = httpRequest(url + "/batches", { method: "POST", headers: { "Content-Type": "application/json" } }, (response) => {
        let message = "";
        response.setEncoding("utf8").on("data", (chunk: string) => { message += chunk; });
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode!, message }));
      });
      t.after(() => request.destroy());
      request.on("error", reject);
      request.write(bytes.subarray(0, 600_000)); // No Content-Length: real chunked transfer.
      request.end(bytes.subarray(600_000));
    });
    assert.equal(result.status, 413);
    assert.equal(typeof JSON.parse(result.message).error, "string");
    assert.equal(server.snapshot().serverSeq, 0);
    const message = JSON.stringify(batch());
    const response = await fetch(url + "/batches", {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
      body: message.padEnd(1024 * 1024, " "),
    });
    await response.text();
    assert.equal(response.status, 204);
    assert.equal(server.snapshot().serverSeq, 1);
  });

  it("orders completed bodies rather than initial HTTP request arrival", async (t) => {
    const seen: string[] = [];
    const server = createServer(Board, { resolve: ({ batch: incoming }) => {
      seen.push(incoming.clientId);
      return incoming.operations;
    } });
    const { url } = await host(t, server);
    const message = JSON.stringify(batch("a", 1, 2));
    let request!: ReturnType<typeof httpRequest>;
    const response = new Promise<number>((resolve, reject) => {
      request = httpRequest(url + "/batches", { method: "POST", headers: { "Content-Type": "application/json" } }, (incoming) => {
        incoming.resume();
        incoming.on("error", reject);
        incoming.on("end", () => resolve(incoming.statusCode!));
      });
      request.on("error", reject);
    });
    void response.catch(() => {});
    t.after(() => request.destroy());
    const connected = new Promise<void>((resolve) => request.once("socket", (socket) => {
      if (socket.connecting) socket.once("connect", resolve); else resolve();
    }));
    request.write(message.slice(0, 10));
    await connected;
    assert.equal(await post(url, batch("b")), 204);
    request.end(message.slice(10));
    assert.equal(await response, 204);
    assert.deepEqual(seen, ["b", "a"]);
    assert.equal(server.snapshot().data.count, 2);
  });

  it("contains handler and resolver failures in one request and remains usable", async (t) => {
    let fail = true;
    const server = createServer(Board, { resolve: ({ batch: incoming }) => {
      if (fail) throw new Error("Private resolver details");
      return incoming.operations;
    } });
    const { url } = await host(t, server);
    assert.equal(await post(url, batch()), 409);
    assert.equal(server.snapshot().serverSeq, 0);
    fail = false;
    assert.equal(await post(url, batch()), 204);
    const snapshot = t.mock.method(server, "snapshot", () => { throw new Error("Private handler details"); });
    const response = await fetch(url + "/snapshot");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal server error" });
    snapshot.mock.restore();
    assert.equal(await post(url, batch("a", 2)), 204);
  });

  it("retains pending after a lost POST response and lets the server replay the original batch", async (t) => {
    let calls = 0;
    const server = createServer(Board, { resolve: ({ batch: incoming }) => { calls++; return incoming.operations; } });
    const { url } = await host(t, server);
    const failure = new Error("Response lost after acceptance");
    const a = await connectHttpExampleClient(url, "a", { fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === "POST") { await response.text(); throw failure; }
      return response;
    } });
    const peer = await connectHttpExampleClient(url, "peer");
    a.doc.state.count.value = 1;
    const pending = a.doc.checkpoint().pendingBatches[0]!;
    await assert.rejects(a.sync(), (error: unknown) => error === failure);
    assert.equal(server.snapshot().serverSeq, 1);
    assert.equal(a.doc.checkpoint().snapshot.serverSeq, 0);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, [pending]);
    await assert.rejects(a.sync(), (error: unknown) => error === failure);
    assert.equal(await post(url, pending), 204);
    assert.equal(calls, 1);
    assert.equal(server.commitsSince(0)!.length, 1);
    assert.equal(await peer.sync(), true);
    assert.equal(peer.doc.state.count.value, 1);
  });

  it("consumes HTTP errors and stops only the failing client", async (t) => {
    const server = createServer(Board, { resolve: ({ batch: incoming }) => {
      if (incoming.clientId === "a") throw new Error("Cannot resolve this batch");
      return incoming.operations;
    } });
    const { url } = await host(t, server);
    const responses: Response[] = [];
    const a = await connectHttpExampleClient(url, "a", { fetch: async (input, init) => {
      const response = await fetch(input, init);
      responses.push(response);
      return response;
    } });
    a.doc.state.count.value = 1;
    let failure: unknown;
    await assert.rejects(a.sync(), (error: unknown) => {
      failure = error;
      return error instanceof Error && error.message.includes("409");
    });
    await assert.rejects(a.sync(), (error: unknown) => error === failure);
    assert.equal(responses.length, 3);
    assert.ok(responses.every((response) => response.bodyUsed));
    assert.equal(a.doc.checkpoint().pendingBatches.length, 1);
    assert.equal(server.snapshot().serverSeq, 0);
    const peer = await connectHttpExampleClient(url, "peer");
    peer.doc.state.count.value = 2;
    assert.equal(await peer.sync(), true);
    assert.equal(server.snapshot().data.count, 2);
  });

  it("stops on malformed, unordered or state-invalid responses before submitting pending", async (t) => {
    for (const mode of ["json", "container", "wire", "reversed", "gap", "duplicate", "state"] as const) {
      const server = createServer(Board);
      const { url } = await host(t, server);
      let requests = 0;
      const a = await connectHttpExampleClient(url, "a", { fetch: async (input, init) => {
        requests++;
        const response = await fetch(input, init);
        if (!String(input).includes("/commits?")) return response;
        const commits = await response.json();
        let changed: unknown = commits;
        if (mode === "container") changed = {};
        if (mode === "wire") changed = [commits[0], { ...commits[1], extra: true }];
        if (mode === "reversed") changed = [...commits].reverse();
        if (mode === "gap") changed = commits.slice(1);
        if (mode === "duplicate") changed = [commits[0], commits[0]];
        if (mode === "state") changed = [{ ...commits[0], operations: [
          { type: "list/delete", path: "items", id: { bunchId: "unknown", counter: 0 } },
        ] }];
        return new Response(mode === "json" ? "{" : JSON.stringify(changed), { status: 200 });
      } });
      const peer = await connectHttpExampleClient(url, "peer");
      peer.doc.state.count.value = 1;
      peer.doc.state.count.value = 2;
      assert.equal(await peer.sync(), true);
      a.doc.state.count.value = 20;
      const before = a.doc.checkpoint();
      let failure: unknown;
      await assert.rejects(a.sync(), (error: unknown) => { failure = error; return true; });
      await assert.rejects(a.sync(), (error: unknown) => error === failure);
      assert.deepEqual(a.doc.checkpoint(), before);
      assert.equal(requests, 2);
      assert.equal(server.snapshot().serverSeq, 2);
      assert.equal(await peer.sync(), true);
    }
  });

  it("preserves applied state and remaining pending when an incoming listener throws", async (t) => {
    const server = createServer(Board);
    const { url } = await host(t, server);
    const a = await connectHttpExampleClient(url, "a");
    const peer = await connectHttpExampleClient(url, "peer");
    a.doc.state.count.value = 1;
    a.doc.state.count.value = 2;
    peer.doc.state.items.push("Remote");
    assert.equal(await peer.sync(), true);
    const failure = new Error("Incoming listener failed");
    a.doc.on("change", (event) => { if (event.origin === "server") throw failure; });
    await assert.rejects(a.sync(), (error: unknown) => error === failure);
    await assert.rejects(a.sync(), (error: unknown) => error === failure);
    assert.equal(a.doc.checkpoint().snapshot.serverSeq, 1);
    assert.deepEqual(a.doc.state.items.toArray(), ["Remote"]);
    assert.deepEqual(a.doc.checkpoint().pendingBatches.map((entry) => entry.seq), [1, 2]);
    assert.equal(server.snapshot().serverSeq, 1);
    peer.doc.state.count.value = 3;
    assert.equal(await peer.sync(), true);
  });

  it("rejects concurrent and reentrant sync without stopping the active sync", async (t) => {
    const server = createServer(Board);
    const { url } = await host(t, server);
    const entered = gate();
    const release = gate();
    t.after(() => release.resolve());
    let paused = false;
    const a = await connectHttpExampleClient(url, "a", { fetch: async (input, init) => {
      if (!paused && String(input).includes("/commits?")) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return fetch(input, init);
    } });
    const peer = await connectHttpExampleClient(url, "peer");
    a.doc.state.count.value = 1;
    const syncing = a.sync();
    void syncing.catch(() => {});
    let reentrant: Promise<boolean> | undefined;
    a.doc.on("change", (event) => {
      if (event.origin !== "server") return;
      reentrant = a.sync();
      void reentrant.catch(() => {});
    });
    try {
      await entered.promise;
      await assert.rejects(a.sync(), /concurrently or reentrantly/);
      peer.doc.state.items.push("Remote");
      assert.equal(await peer.sync(), true);
    } finally {
      release.resolve();
    }
    assert.equal(await syncing, true);
    assert.ok(reentrant);
    await assert.rejects(reentrant, /concurrently or reentrantly/);
    assert.equal(await a.sync(), true);
    assert.deepEqual(a.doc.checkpoint().snapshot, server.snapshot());
  });

  it("does not loop when POST succeeds without a catch-up ack, or history expires after POST", async (t) => {
    for (const mode of ["missing-ack", "history-gap"] as const) {
      const server = createServer(Board, mode === "history-gap" ? { historyLimit: 0 } : {});
      const { url } = await host(t, server);
      let submitted = false;
      let posts = 0;
      const a = await connectHttpExampleClient(url, "a", { fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === "POST") { submitted = true; posts++; }
        if (mode === "missing-ack" && submitted && String(input).includes("/commits?")) {
          await response.text();
          return new Response("[]", { status: 200 });
        }
        return response;
      } });
      a.doc.state.count.value = 1;
      if (mode === "missing-ack") {
        await assert.rejects(a.sync(), /without acknowledging/);
        await assert.rejects(a.sync(), /without acknowledging/);
      } else {
        assert.equal(await a.sync(), false);
        assert.equal(await a.sync(), false);
      }
      assert.equal(posts, 1);
      assert.equal(server.snapshot().serverSeq, 1);
      assert.equal(a.doc.checkpoint().snapshot.serverSeq, 0);
      assert.equal(a.doc.checkpoint().pendingBatches.length, 1);
    }
  });

  it("syncs a separate client process through HTTP while the parent serves requests", async (t) => {
    const server = createServer(Board);
    const { url } = await host(t, server);
    const peer = await connectHttpExampleClient(url, "peer");
    const code = [
      "import { connectHttpExampleClient } from " + JSON.stringify(exampleUrl),
      "const client = await connectHttpExampleClient(" + JSON.stringify(url) + ", 'child')",
      "client.doc.transact(() => { client.doc.state.count.value = 7; client.doc.state.items.push('Child'); client.doc.state.body.insert(0, '😀'); })",
      "if (!(await client.sync())) throw new Error('Unexpected history gap')",
      "console.log(JSON.stringify(client.doc.checkpoint()))",
    ].join(";\n");
    const saved = JSON.parse(await child(t, code));
    assert.deepEqual(saved.pendingBatches, []);
    assert.deepEqual(saved.snapshot, server.snapshot());
    assert.equal(await peer.sync(), true);
    assert.deepEqual(peer.doc.state.items.toArray(), ["Child"]);
    assert.equal(peer.doc.state.body.toString(), "😀");
    assert.equal(peer.doc.state.count.value, 7);
  });
});
