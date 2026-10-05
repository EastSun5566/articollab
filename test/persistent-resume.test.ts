import assert from "node:assert/strict";
import { decodeClientBatch, decodeServerCommit } from "../src/index.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import { createAsyncExampleNetwork } from "../examples/async-resume.ts";
import { createCheckpointStore } from "../examples/persistent-resume.ts";
import { Board } from "../examples/resume.ts";
import {
  createClient, createServer, WireDecodeError,
  type ClientDocument, type CreateServerOptions,
} from "../src/index.ts";

type Shape = typeof Board.definition;
type Store = ReturnType<typeof createCheckpointStore>;
type Options = NonNullable<Parameters<typeof createAsyncExampleNetwork>[1]>;

function directory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "articollab-persistence-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function boot(store: Store, serverOptions: CreateServerOptions<Shape> = {}, options: Options = {}) {
  const checkpoint = store.loadServer();
  const server = createServer(Board, { ...serverOptions, ...(checkpoint === null ? {} : { checkpoint }) });
  store.saveServer(server.checkpoint());
  const network = createAsyncExampleNetwork(server, {
    saveClientCheckpoint: store.saveClient, saveServerCheckpoint: store.saveServer, ...options,
  });
  return { server, network };
}

function converged(store: Store, server: ReturnType<typeof createServer<Shape>>,
  ...docs: ClientDocument<Shape>[]): void {
  assert.deepEqual(store.loadServer(), server.checkpoint());
  for (const doc of docs) {
    const checkpoint = doc.checkpoint();
    assert.deepEqual(checkpoint.pendingBatches, []);
    assert.deepEqual(checkpoint.snapshot, server.snapshot());
    assert.deepEqual(store.loadClient(checkpoint.clientId), checkpoint);
  }
}

describe("file-backed checkpoint recovery example", () => {
  it("imports without demo side effects and rejects async saving callbacks at type check", () => {
    const url = new URL("../examples/persistent-resume.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module",
      "-e", "await import(" + JSON.stringify(url) + ")"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    // oxlint-disable-next-line eslint/no-constant-condition -- Compile-only negative type assertions must never execute.
    if (false) {
      createAsyncExampleNetwork(createServer(Board), {
        // @ts-expect-error Saving callbacks must finish synchronously.
        saveClientCheckpoint: async () => {},
        // @ts-expect-error Saving callbacks must finish synchronously.
        saveServerCheckpoint: async () => {},
      });
    }
  });

  it("loads only official files, decodes owned checkpoints, and uses encoded client filenames", (t) => {
    const root = directory(t);
    const store = createCheckpointStore(root);
    assert.equal(store.loadServer(), null);
    assert.equal(store.loadClient("a"), null);
    const server = createServer(Board);
    store.saveServer(server.checkpoint());
    const id = "../a/b";
    const doc = createClient(Board, { clientId: id, onBatch() {} });
    doc.state.items.push("pending");
    store.saveClient(doc.checkpoint());
    const clientFile = join(root, "client-2e002e002f0061002f006200.json");
    assert.ok(existsSync(clientFile));
    assert.equal(statSync(clientFile).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "server.json")).mode & 0o777, 0o600);
    const loaded = store.loadClient(id)!;
    assert.deepEqual(loaded, doc.checkpoint());
    assert.notEqual(loaded, doc.checkpoint());
    assert.ok(Object.isFrozen(loaded));
    assert.ok(Object.isFrozen(loaded.pendingBatches[0]!.operations[0]));
    writeFileSync(join(root, "server.json.tmp"), "{unfinished");
    assert.deepEqual(store.loadServer(), server.checkpoint());
    store.saveServer(server.checkpoint());
    assert.equal(existsSync(join(root, "server.json.tmp")), false);
    const missing = join(root, "client-6100.json.tmp");
    writeFileSync(missing, JSON.stringify(loaded));
    assert.equal(store.loadClient("a"), null);
    writeFileSync(join(root, "client-6100.json"), JSON.stringify(loaded));
    assert.throws(() => store.loadClient("a"), /clientId does not match/);
  });

  it("keeps case, Unicode normalization and lone-surrogate client IDs in separate files", (t) => {
    const root = directory(t);
    const store = createCheckpointStore(root);
    const ids = ["a", "A", "é", "e\u0301", "\ud800", "\ud801"];
    const checkpoints = ids.map((clientId, index) => {
      const doc = createClient(Board, { clientId, onBatch() {} });
      doc.state.count.value = index + 1;
      const checkpoint = doc.checkpoint();
      store.saveClient(checkpoint);
      return checkpoint;
    });
    const files = readdirSync(root);
    assert.equal(files.length, ids.length);
    for (const file of files) assert.match(file, /^client-[0-9a-f]+\.json$/);
    assert.ok(files.includes("client-6100.json"));
    assert.ok(files.includes("client-4100.json"));
    for (const checkpoint of checkpoints) {
      assert.deepEqual(store.loadClient(checkpoint.clientId), checkpoint);
    }
  });

  it("does not turn corrupt files, invalid checkpoints or filesystem failures into fresh state", (t) => {
    const root = directory(t);
    const store = createCheckpointStore(root);
    assert.throws(() => createCheckpointStore(join(root, "missing")));
    const path = join(root, "server.json");
    writeFileSync(path, "{");
    assert.throws(() => createCheckpointStore(path), /must be a directory/);
    assert.throws(() => store.loadServer(), SyntaxError);
    writeFileSync(path, "{}");
    assert.throws(() => store.loadServer(), WireDecodeError);
    writeFileSync(join(root, "client-6100.json"), "{}");
    assert.throws(() => store.loadClient("a"), WireDecodeError);
    mkdirSync(join(root, "client-6200.json"));
    assert.throws(() => store.loadClient("b"), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "EISDIR");

    const checkpoint = createServer(Board).checkpoint();
    store.saveServer(checkpoint);
    const before = readFileSync(path, "utf8");
    // Both the write and its cleanup fail; retain the original open/write error.
    mkdirSync(path + ".tmp");
    assert.throws(() => store.saveServer(checkpoint), (error: unknown) =>
      error instanceof Error && "syscall" in error && error.syscall === "open");
    assert.equal(readFileSync(path, "utf8"), before);
    assert.ok(statSync(path + ".tmp").isDirectory());

    const otherRoot = directory(t);
    const otherStore = createCheckpointStore(otherRoot);
    const target = join(otherRoot, "server.json");
    mkdirSync(target); // The temporary write succeeds, but replacement fails.
    assert.throws(() => otherStore.saveServer(checkpoint), (error: unknown) =>
      error instanceof Error && "syscall" in error && error.syscall === "rename");
    assert.ok(statSync(target).isDirectory());
    assert.equal(existsSync(target + ".tmp"), false);
  });

  it("saves pending before a subprocess exits without waiting for delivery", async (t) => {
    const root = directory(t);
    const example = new URL("../examples/persistent-resume.ts", import.meta.url).href;
    const asyncExample = new URL("../examples/async-resume.ts", import.meta.url).href;
    const syncExample = new URL("../examples/resume.ts", import.meta.url).href;
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const code = [
      "import { createCheckpointStore } from " + JSON.stringify(example),
      "import { createAsyncExampleNetwork } from " + JSON.stringify(asyncExample),
      "import { Board } from " + JSON.stringify(syncExample),
      "import { createServer } from " + JSON.stringify(entry),
      "const store = createCheckpointStore(" + JSON.stringify(root) + ")",
      "const server = createServer(Board)",
      "store.saveServer(server.checkpoint())",
      "const network = createAsyncExampleNetwork(server, { saveClientCheckpoint: store.saveClient, saveServerCheckpoint: store.saveServer })",
      "const { doc } = network.connect('a')",
      "doc.transact(() => { doc.state.count.value = 1; doc.state.items.push('saved'); doc.state.body.insert(0, '😀'); })",
      "process.exit(0)", // No Promise jobs, drain or graceful-shutdown handler.
    ].join(";\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    const store = createCheckpointStore(root);
    assert.equal(store.loadServer()!.snapshot.serverSeq, 0);
    const checkpoint = store.loadClient("a")!;
    assert.equal(checkpoint.pendingBatches.length, 1);
    const { server, network } = boot(store);
    const peer = network.connect("b");
    const source = network.connect("a", checkpoint);
    assert.equal(source.doc.state.body.toString(), "😀");
    assert.equal(await source.resume(), true);
    await network.idle();
    converged(store, server, source.doc, peer.doc);
  });

  it("restores mixed tombstones, several lost acks, sequences and fresh ID allocations from files", async (t) => {
    const store = createCheckpointStore(directory(t));
    const first = boot(store);
    const source = first.network.connect("a");
    const peer = first.network.connect("b");
    source.disconnect();
    source.doc.transact(() => {
      source.doc.state.count.value = 1;
      source.doc.state.items.push("seed");
      source.doc.state.body.insert(0, "😀");
    });
    source.doc.transact(() => {
      source.doc.state.count.value = 2;
      source.doc.state.items.delete(0);
      source.doc.state.body.delete(0);
    });
    source.doc.transact(() => {
      source.doc.state.count.value = 3;
      source.doc.state.items.push("restored");
      source.doc.state.body.insert(0, "B😀");
    });
    const saved = store.loadClient("a")!;
    for (const batch of saved.pendingBatches.slice(0, 2)) await first.network.submit(batch);
    await first.network.idle();
    peer.disconnect();
    const serverCheckpoint = store.loadServer()!;
    assert.equal(serverCheckpoint.snapshot.serverSeq, 2);
    assert.deepEqual(serverCheckpoint.snapshot.data.items.values, []);
    assert.ok(serverCheckpoint.snapshot.data.items.idList.length > 0);
    assert.equal(serverCheckpoint.snapshot.data.body.value, "");
    assert.ok(serverCheckpoint.snapshot.data.body.idList.length > 0);
    const seen: number[] = [];
    const next = boot(store, { resolve: ({ batch }) => { seen.push(batch.seq); return batch.operations; } });
    assert.deepEqual(next.server.checkpoint(), serverCheckpoint);
    const restoredPeer = next.network.connect("b", store.loadClient("b")!);
    assert.equal(await restoredPeer.resume(), true);
    await next.network.idle();
    const restored = next.network.connect("a", store.loadClient("a")!);
    assert.equal(await restored.resume(), true);
    await next.network.idle();
    assert.deepEqual(seen, [3]);
    restored.doc.transact(() => {
      restored.doc.state.count.value = 4;
      restored.doc.state.items.push("live");
      restored.doc.state.body.insert(2, "!");
    });
    await next.network.idle();
    assert.deepEqual(seen, [3, 4]);
    assert.deepEqual(restored.doc.state.items.toArray(), ["restored", "live"]);
    assert.equal(restored.doc.state.body.toString(), "B😀!");
    assert.equal(restored.doc.checkpoint().lastBunchSeqs.items, saved.lastBunchSeqs.items + 1);
    assert.equal(restored.doc.checkpoint().lastBunchSeqs.body, saved.lastBunchSeqs.body + 1);
    assert.deepEqual(saved.pendingBatches.map((batch) => batch.seq), [1, 2, 3]);
    converged(store, next.server, restored.doc, restoredPeer.doc);
  });

  it("persists accept, reject and transform before delivery and saves silent own acknowledgements", async (t) => {
    for (const mode of ["accept", "reject", "transform"] as const) {
      const store = createCheckpointStore(directory(t));
      const serverSaves: number[] = [];
      const clientWatermarks: number[] = [];
      const { server, network } = boot(store, { resolve: ({ batch }) => {
        if (batch.seq === 1 || mode === "accept") return batch.operations;
        if (mode === "reject") return [];
        return batch.operations.map((op) => op.type === "value/set" ? { ...op, value: 5 } : op);
      } }, {
        saveServerCheckpoint(checkpoint) { store.saveServer(checkpoint); serverSaves.push(checkpoint.snapshot.serverSeq); },
        saveClientCheckpoint(checkpoint) {
          store.saveClient(checkpoint);
          if (checkpoint.clientId === "a") clientWatermarks.push(checkpoint.snapshot.serverSeq);
        },
        transfer: async (direction, id, message) => {
          if (direction === "client-to-server") {
            const batch = decodeClientBatch(Board, JSON.parse(message));
            assert.ok(store.loadClient(id)!.pendingBatches.some((pending) => pending.seq === batch.seq));
          } else {
            assert.ok(store.loadServer()!.snapshot.serverSeq >= decodeServerCommit(Board, JSON.parse(message)).serverSeq);
          }
          return message;
        },
      });
      const source = network.connect("a");
      const peer = network.connect("b");
      let changes = 0;
      source.doc.on("change", (event) => { if (event.origin === "server") changes++; });
      source.doc.transact(() => {
        source.doc.state.items.push("seed");
        source.doc.state.body.insert(0, "😀");
      });
      await network.idle();
      assert.equal(changes, 0);
      assert.equal(store.loadClient("a")!.snapshot.serverSeq, 1);
      source.doc.transact(() => {
        source.doc.state.count.value = 10;
        source.doc.state.items.delete(0);
        source.doc.state.body.delete(0);
      });
      await network.idle();
      assert.deepEqual(serverSaves, [1, 2]);
      assert.ok(clientWatermarks.includes(2));
      assert.equal(changes, mode === "accept" ? 0 : 1);
      assert.equal(source.doc.state.count.value, mode === "reject" ? 0 : mode === "transform" ? 5 : 10);
      assert.deepEqual(source.doc.state.items.toArray(), mode === "reject" ? ["seed"] : []);
      assert.equal(source.doc.state.body.toString(), mode === "reject" ? "😀" : "");
      converged(store, server, source.doc, peer.doc);
    }
  });

  it("stops immediately when the initial client save fails, before registering or sending", async (t) => {
    const store = createCheckpointStore(directory(t));
    const expected = new Error("initial save failed");
    let requests = 0;
    const { network } = boot(store, {}, {
      saveClientCheckpoint() { throw expected; },
      transfer: async (_direction, _id, message) => { requests++; return message; },
    });
    assert.throws(() => network.connect("a"), (error: unknown) => error === expected);
    assert.equal(store.loadClient("a"), null);
    assert.equal(requests, 0);
    await assert.rejects(network.idle(), (error: unknown) => error === expected);
    assert.throws(() => network.connect("b"), (error: unknown) => error === expected);
  });

  it("preserves the last saved pending batch and cancels queued sends on local save failure", async (t) => {
    const store = createCheckpointStore(directory(t));
    const expected = new Error("local save failed");
    let requests = 0;
    const { server, network } = boot(store, {}, {
      saveClientCheckpoint(checkpoint) {
        if (checkpoint.lastLocalSeq === 2) throw expected;
        store.saveClient(checkpoint);
      },
      transfer: async (direction, _id, message) => {
        if (direction === "client-to-server") requests++;
        return message;
      },
    });
    const source = network.connect("a");
    source.doc.state.count.value = 1;
    const drained = assert.rejects(network.idle(), (error: unknown) => error === expected);
    assert.throws(() => { source.doc.state.count.value = 2; }, (error: unknown) => error === expected);
    await drained;
    assert.equal(requests, 0);
    assert.equal(server.snapshot().serverSeq, 0);
    assert.deepEqual(source.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [1, 2]);
    assert.deepEqual(store.loadClient("a")!.pendingBatches.map((batch) => batch.seq), [1]);
    const next = boot(store);
    const restored = next.network.connect("a", store.loadClient("a")!);
    assert.equal(await restored.resume(), true);
    await next.network.idle();
    assert.equal(restored.doc.state.count.value, 1); // The failed edit was never promised durable.
    converged(store, next.server, restored.doc);
  });

  it("does not broadcast after a server save failure and restores the earlier server file", async (t) => {
    const store = createCheckpointStore(directory(t));
    const expected = new Error("server save failed");
    let deliveries = 0;
    const first = boot(store, {}, {
      saveServerCheckpoint() { throw expected; },
      transfer: async (direction, _id, message) => {
        if (direction === "server-to-client") deliveries++;
        return message;
      },
    });
    const source = first.network.connect("a");
    const peer = first.network.connect("b");
    source.doc.state.count.value = 1;
    await assert.rejects(first.network.idle(), (error: unknown) => error === expected);
    assert.equal(first.server.snapshot().serverSeq, 1); // Discard this advanced in-memory instance.
    assert.equal(store.loadServer()!.snapshot.serverSeq, 0);
    assert.equal(deliveries, 0);
    assert.equal(peer.doc.checkpoint().snapshot.serverSeq, 0);
    assert.equal(store.loadClient("a")!.pendingBatches.length, 1);
    const next = boot(store);
    const restoredPeer = next.network.connect("b", store.loadClient("b")!);
    assert.equal(await restoredPeer.resume(), true);
    await next.network.idle();
    const restored = next.network.connect("a", store.loadClient("a")!);
    assert.equal(await restored.resume(), true);
    await next.network.idle();
    assert.equal(next.server.snapshot().serverSeq, 1);
    converged(store, next.server, restored.doc, restoredPeer.doc);
  });

  it("recovers saved accept, reject and transform results after failure before broadcast", async (t) => {
    for (const mode of ["accept", "reject", "transform"] as const) {
      const store = createCheckpointStore(directory(t));
      const expected = new Error("stopped after saving");
      let stopAfterSave = false;
      let deliveries = 0;
      const first = boot(store, { resolve: ({ batch }) => {
        if (batch.seq === 1 || mode === "accept") return batch.operations;
        if (mode === "reject") return [];
        return batch.operations.map((op) => op.type === "value/set" ? { ...op, value: 5 } : op);
      } }, {
        saveServerCheckpoint(checkpoint) {
          store.saveServer(checkpoint);
          if (stopAfterSave) throw expected;
        },
        transfer: async (direction, _id, message) => {
          if (direction === "server-to-client") deliveries++;
          return message;
        },
      });
      const source = first.network.connect("a");
      const peer = first.network.connect("b");
      source.doc.transact(() => {
        source.doc.state.items.push("seed");
        source.doc.state.body.insert(0, "😀");
      });
      await first.network.idle();
      stopAfterSave = true;
      deliveries = 0;
      source.doc.transact(() => {
        source.doc.state.count.value = 10;
        source.doc.state.items.delete(0);
        source.doc.state.body.delete(0);
      });
      await assert.rejects(first.network.idle(), (error: unknown) => error === expected);
      assert.equal(deliveries, 0);
      assert.equal(store.loadServer()!.snapshot.serverSeq, 2);
      assert.equal(store.loadClient("a")!.snapshot.serverSeq, 1);
      assert.equal(peer.doc.checkpoint().snapshot.serverSeq, 1);
      let calls = 0;
      const next = boot(store, { resolve: () => { calls++; throw new Error("must use saved result"); } });
      const restoredPeer = next.network.connect("b", store.loadClient("b")!);
      assert.equal(await restoredPeer.resume(), true);
      await next.network.idle();
      const restored = next.network.connect("a", store.loadClient("a")!);
      assert.equal(await restored.resume(), true);
      await next.network.idle();
      assert.equal(calls, 0);
      assert.equal(restored.doc.state.count.value, mode === "reject" ? 0 : mode === "transform" ? 5 : 10);
      assert.deepEqual(restored.doc.state.items.toArray(), mode === "reject" ? ["seed"] : []);
      assert.equal(restored.doc.state.body.toString(), mode === "reject" ? "😀" : "");
      converged(store, next.server, restored.doc, restoredPeer.doc);
    }
  });

  it("recovers an applied silent ack whose client checkpoint save failed", async (t) => {
    const store = createCheckpointStore(directory(t));
    const expected = new Error("ack save failed");
    const first = boot(store, {}, {
      saveClientCheckpoint(checkpoint) {
        if (checkpoint.clientId === "a" && checkpoint.snapshot.serverSeq === 1) throw expected;
        store.saveClient(checkpoint);
      },
    });
    const source = first.network.connect("a");
    const peer = first.network.connect("b");
    let changes = 0;
    source.doc.on("change", (event) => { if (event.origin === "server") changes++; });
    source.doc.state.count.value = 1;
    await assert.rejects(first.network.idle(), (error: unknown) => error === expected);
    assert.equal(changes, 0);
    assert.equal(source.doc.checkpoint().snapshot.serverSeq, 1);
    assert.deepEqual(source.doc.checkpoint().pendingBatches, []);
    assert.equal(store.loadClient("a")!.snapshot.serverSeq, 0);
    assert.equal(store.loadClient("a")!.pendingBatches.length, 1);
    assert.equal(store.loadServer()!.snapshot.serverSeq, 1);
    assert.equal(peer.doc.checkpoint().snapshot.serverSeq, 0);
    let calls = 0;
    const next = boot(store, { resolve: ({ batch }) => { calls++; return batch.operations; } });
    const restoredPeer = next.network.connect("b", store.loadClient("b")!);
    assert.equal(await restoredPeer.resume(), true);
    await next.network.idle();
    const restored = next.network.connect("a", store.loadClient("a")!);
    assert.equal(await restored.resume(), true);
    await next.network.idle();
    assert.equal(calls, 0);
    converged(store, next.server, restored.doc, restoredPeer.doc);
  });

  it("saves listener edits behind older pending work and does not save or broadcast retries again", async (t) => {
    const store = createCheckpointStore(directory(t));
    const seenA: number[] = [];
    const savedPending: number[][] = [];
    let clientWrites = 0;
    let serverWrites = 0;
    let peerDeliveries = 0;
    const { server, network } = boot(store, { resolve: ({ batch }) => {
      if (batch.clientId === "a") seenA.push(batch.seq);
      return batch.clientId === "a" && batch.seq === 1 ? [] : batch.operations;
    } }, {
      saveClientCheckpoint(checkpoint) {
        store.saveClient(checkpoint);
        clientWrites++;
        if (checkpoint.clientId === "a" && checkpoint.snapshot.serverSeq === 1) {
          savedPending.push(checkpoint.pendingBatches.map((batch) => batch.seq));
        }
      },
      saveServerCheckpoint(checkpoint) { store.saveServer(checkpoint); serverWrites++; },
      transfer: async (direction, id, message) => {
        if (direction === "server-to-client" && id === "b") peerDeliveries++;
        return message;
      },
    });
    const original = network.connect("a");
    const peer = network.connect("b");
    original.disconnect();
    original.doc.state.count.value = 10;
    original.doc.transact(() => {
      original.doc.state.items.push("older");
      original.doc.state.body.insert(0, "older");
    });
    const restored = network.connect("a", store.loadClient("a")!);
    let edited = false;
    restored.doc.on("change", (event) => {
      if (event.origin === "server" && !edited) {
        edited = true;
        restored.doc.state.count.value = 30;
      }
    });
    let peerEdited = false;
    peer.doc.on("change", (event) => {
      if (event.origin === "server" && event.commit.source.clientId === "a"
          && event.commit.source.seq === 2 && !peerEdited) {
        peerEdited = true;
        peer.doc.state.count.value = 40;
      }
    });
    assert.equal(await restored.resume(), true);
    await network.idle();
    assert.equal(edited, true);
    assert.equal(peerEdited, true);
    assert.deepEqual(seenA, [1, 2, 3]);
    assert.ok(savedPending.some((seqs) => JSON.stringify(seqs) === "[2,3]"));
    converged(store, server, restored.doc, peer.doc);
    const before = { clientWrites, serverWrites, peerDeliveries };
    const checkpoint = store.loadServer()!;
    const batch = checkpoint.replays.find((entry) => entry.batch.clientId === "a")!.batch;
    await network.submit(batch);
    await network.idle();
    assert.deepEqual({ clientWrites, serverWrites, peerDeliveries }, before);
    assert.deepEqual(store.loadServer(), checkpoint);
    converged(store, server, restored.doc, peer.doc);
  });

  it("retains the listener error without attempting an extra failing save", async (t) => {
    const store = createCheckpointStore(directory(t));
    const expected = new Error("incoming listener failed");
    const saves: number[] = [];
    const first = boot(store, { resolve: () => [{ type: "value/set", path: "count", value: 2 }] }, {
      saveClientCheckpoint(checkpoint) {
        saves.push(checkpoint.snapshot.serverSeq);
        if (checkpoint.snapshot.serverSeq > 0) throw new Error("must not mask listener failure");
        store.saveClient(checkpoint);
      },
    });
    const source = first.network.connect("a");
    source.doc.on("change", (event) => { if (event.origin === "server") throw expected; });
    source.doc.state.count.value = 1;
    await assert.rejects(first.network.idle(), (error: unknown) => error === expected);
    assert.deepEqual(saves, [0, 0]);
    assert.equal(source.doc.checkpoint().snapshot.serverSeq, 1);
    assert.equal(store.loadClient("a")!.snapshot.serverSeq, 0);
    const next = boot(store);
    const restored = next.network.connect("a", store.loadClient("a")!);
    assert.equal(await restored.resume(), true);
    await next.network.idle();
    assert.equal(restored.doc.state.count.value, 2);
    converged(store, next.server, restored.doc);
  });

  it("leaves saved pending disconnected without submission when history is insufficient", async (t) => {
    const store = createCheckpointStore(directory(t));
    const first = boot(store, { historyLimit: 0 });
    const source = first.network.connect("a");
    const peer = first.network.connect("b");
    source.disconnect();
    source.doc.state.count.value = 1;
    peer.doc.state.count.value = 2;
    await first.network.idle();
    peer.disconnect();
    const saved = store.loadClient("a")!;
    let requests = 0;
    const next = boot(store, { historyLimit: 0 }, {
      transfer: async (direction, _id, message) => {
        if (direction === "client-to-server") requests++;
        return message;
      },
    });
    const restored = next.network.connect("a", saved);
    assert.equal(await restored.resume(), false);
    assert.equal(await restored.resume(), false);
    await next.network.idle();
    assert.equal(requests, 0);
    assert.deepEqual(restored.doc.checkpoint(), saved);
    assert.deepEqual(store.loadClient("a"), saved);
    assert.equal(store.loadServer()!.snapshot.serverSeq, 1);
  });
});
