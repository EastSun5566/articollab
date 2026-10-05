import { decodeServerCommit } from "../src/index.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { createAsyncExampleNetwork } from "../examples/async-resume.ts";
import { Board } from "../examples/resume.ts";
import {
  createServer, decodeClientCheckpoint, decodeServerCheckpoint, WireDecodeError,
  type ClientDocument, type ClientCheckpoint,
} from "../src/index.ts";

type Shape = typeof Board.definition;

function gate() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function roundTrip(checkpoint: ClientCheckpoint<Shape>): ClientCheckpoint<Shape> {
  return decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(checkpoint)));
}

function view(doc: ClientDocument<Shape>) {
  return { count: doc.state.count.value, items: doc.state.items.toArray(),
    body: doc.state.body.toString() };
}

describe("asynchronous wire/resume example", () => {
  it("has no demo side effects when imported", () => {
    const url = new URL("../examples/async-resume.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, [
      "--unhandled-rejections=strict", "--input-type=module",
      "-e", "await import(" + JSON.stringify(url) + ")",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("updates mixed optimistic state before JSON delivery and drains silent acknowledgements", async () => {
    const seen: number[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => {
      assert.ok(Object.isFrozen(batch));
      assert.ok(Object.isFrozen(batch.operations));
      for (const operation of batch.operations) {
        assert.ok(Object.isFrozen(operation));
        if (operation.type === "list/insert" || operation.type === "text/insert") {
          assert.ok(Object.isFrozen(operation.id));
        }
      }
      seen.push(batch.seq);
      return batch.operations;
    } });
    const network = createAsyncExampleNetwork(server);
    const source = network.connect("a");
    const peer = network.connect("b");
    let changes = 0;
    source.doc.on("change", (event) => { if (event.origin === "server") changes++; });
    source.doc.transact(() => {
      source.doc.state.count.value = 1;
      source.doc.state.items.push("one");
      source.doc.state.body.insert(0, "A😀");
    });
    source.doc.transact(() => {
      source.doc.state.count.value = 2;
      source.doc.state.items.push("two");
      source.doc.state.body.insert(2, "!");
    });
    assert.deepEqual(view(source.doc), { count: 2, items: ["one", "two"], body: "A😀!" });
    assert.equal(server.snapshot().serverSeq, 0);
    assert.equal(source.doc.checkpoint().pendingBatches.length, 2);
    await network.idle();
    assert.deepEqual(seen, [1, 2]);
    assert.equal(changes, 0);
    assert.deepEqual(source.doc.checkpoint().pendingBatches, []);
    assert.deepEqual(source.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
    // idle must also finish the pump flag cleanup, not leave a new edit stranded.
    source.doc.state.count.value = 3;
    await network.idle();
    assert.deepEqual(seen, [1, 2, 3]);
    assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
  });


  it("captures JSON before transfer and resolves submit before a paused recipient receives it", async () => {
    const requestEntered = gate();
    const requestRelease = gate();
    const commitEntered = gate();
    const commitRelease = gate();
    const server = createServer(Board);
    const network = createAsyncExampleNetwork(server, { transfer: async (direction, _id, message) => {
      if (direction === "client-to-server") {
        requestEntered.resolve();
        await requestRelease.promise;
      } else {
        commitEntered.resolve();
        await commitRelease.promise;
      }
      return message;
    } });
    const peer = network.connect("b");
    const operation = { type: "value/set" as const, path: "count" as const, value: 1 };
    const batch = { clientId: "a", seq: 1, operations: [operation] };
    const submitted = network.submit(batch);
    await requestEntered.promise;
    operation.value = 99;
    batch.seq = 7;
    requestRelease.resolve();
    await submitted;
    await commitEntered.promise;
    assert.equal(server.snapshot().data.count, 1);
    assert.equal(server.snapshot().serverSeq, 1);
    assert.equal(peer.doc.checkpoint().snapshot.serverSeq, 0);
    commitRelease.resolve();
    await network.idle();
    assert.equal(peer.doc.state.count.value, 1);
    assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
  });

  it("does not block peers while an ack is paused and sends newer pending work only after ack", async () => {
    const entered = gate();
    const release = gate();
    const peerProcessed = gate();
    const seen: string[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => {
      seen.push(batch.clientId + ":" + batch.seq);
      if (batch.clientId === "b") peerProcessed.resolve();
      return batch.operations;
    } });
    let paused = false;
    const network = createAsyncExampleNetwork(server, { transfer: async (direction, id, message) => {
      if (direction === "server-to-client" && id === "a" && !paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return message;
    } });
    const source = network.connect("a");
    const peer = network.connect("b");
    source.doc.state.count.value = 1;
    await entered.promise;
    source.doc.state.count.value = 2;
    let idleFinished = false;
    const drained = network.idle().then(() => { idleFinished = true; });
    assert.throws(() => network.connect("c"), /must be idle/);
    await assert.rejects(source.resume(), /must be idle/);
    peer.doc.state.count.value = 8;
    await peerProcessed.promise;
    assert.equal(server.snapshot().serverSeq, 2);
    assert.equal(source.doc.checkpoint().snapshot.serverSeq, 0);
    assert.deepEqual(source.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [1, 2]);
    assert.deepEqual(seen, ["a:1", "b:1"]);
    assert.equal(idleFinished, false);
    release.resolve();
    await drained;
    assert.deepEqual(seen, ["a:1", "b:1", "a:2"]);
    assert.deepEqual(view(source.doc), view(peer.doc));
    assert.equal(source.doc.state.count.value, 2);
    assert.deepEqual(source.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
  });

  it("does not put a slow outbound transfer inside the server FIFO", async () => {
    const entered = gate();
    const release = gate();
    const peerProcessed = gate();
    const server = createServer(Board, { resolve: ({ batch }) => {
      if (batch.clientId === "b") peerProcessed.resolve();
      return batch.operations;
    } });
    const network = createAsyncExampleNetwork(server, { transfer: async (direction, id, message) => {
      if (direction === "client-to-server" && id === "a") {
        entered.resolve();
        await release.promise;
      }
      return message;
    } });
    const source = network.connect("a");
    const peer = network.connect("b");
    source.doc.state.count.value = 1;
    await entered.promise;
    peer.doc.state.count.value = 2;
    await peerProcessed.promise;
    assert.equal(server.snapshot().serverSeq, 1);
    assert.equal(server.snapshot().data.count, 2);
    release.resolve();
    await network.idle();
    assert.equal(server.snapshot().serverSeq, 2);
    assert.equal(source.doc.state.count.value, 1);
    assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
  });

  it("restores server and mixed client checkpoints, catching up several lost acks before resending", async () => {
    const originalServer = createServer(Board);
    const originalNetwork = createAsyncExampleNetwork(originalServer);
    const original = originalNetwork.connect("a");
    const peer = originalNetwork.connect("b");
    original.disconnect();
    original.doc.transact(() => {
      original.doc.state.count.value = 1;
      original.doc.state.items.push("seed");
      original.doc.state.body.insert(0, "😀");
    });
    original.doc.transact(() => {
      original.doc.state.count.value = 2;
      original.doc.state.items.delete(0);
      original.doc.state.body.delete(0);
    });
    original.doc.transact(() => {
      original.doc.state.count.value = 3;
      original.doc.state.items.push("restored");
      original.doc.state.body.insert(0, "B😀");
    });
    const checkpoint = roundTrip(original.doc.checkpoint());
    for (const batch of checkpoint.pendingBatches.slice(0, 2)) await originalNetwork.submit(batch);
    await originalNetwork.idle();
    peer.disconnect();
    const peerCheckpoint = roundTrip(peer.doc.checkpoint());
    const seen: number[] = [];
    const server = createServer(Board, {
      checkpoint: decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(originalServer.checkpoint()))),
      resolve: ({ batch }) => { seen.push(batch.seq); return batch.operations; },
    });
    const network = createAsyncExampleNetwork(server);
    const restoredPeer = network.connect("b", peerCheckpoint);
    assert.equal(await restoredPeer.resume(), true);
    const restored = network.connect("a", checkpoint);
    assert.equal(await restored.resume(), true);
    await network.idle();
    assert.deepEqual(seen, [3]); // Older batches cannot use the last-batch retry cache.
    assert.deepEqual(view(restored.doc), { count: 3, items: ["restored"], body: "B😀" });
    assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
    restored.doc.transact(() => {
      restored.doc.state.count.value = 4;
      restored.doc.state.items.push("live");
      restored.doc.state.body.insert(2, "!");
    });
    await network.idle();
    assert.deepEqual(seen, [3, 4]);
    assert.deepEqual(restored.doc.checkpoint().lastBunchSeqs, {
      items: checkpoint.lastBunchSeqs.items + 1,
      body: checkpoint.lastBunchSeqs.body + 1,
    });
    assert.deepEqual(restored.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(restoredPeer.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(checkpoint.pendingBatches.map((batch) => batch.seq), [1, 2, 3]);
  });

  it("reconciles accepted, rejected and transformed mixed work without resolving lost acks twice", async () => {
    for (const mode of ["accept", "reject", "transform"] as const) {
      let calls = 0;
      const server = createServer(Board, { resolve: ({ batch }) => {
        calls++;
        if (batch.seq === 1 || mode === "accept") return batch.operations;
        if (mode === "reject") return [];
        return batch.operations.map((operation) => operation.type === "value/set"
          ? { ...operation, value: 5 } : operation);
      } });
      const network = createAsyncExampleNetwork(server);
      const source = network.connect("a");
      const peer = network.connect("b");
      source.doc.transact(() => {
        source.doc.state.items.push("seed");
        source.doc.state.body.insert(0, "😀");
      });
      await network.idle();
      source.disconnect();
      source.doc.transact(() => {
        source.doc.state.count.value = 10;
        source.doc.state.items.delete(0);
        source.doc.state.body.delete(0);
      });
      const checkpoint = roundTrip(source.doc.checkpoint());
      await network.submit(checkpoint.pendingBatches[0]!);
      await network.idle();
      const restored = network.connect("a", checkpoint);
      assert.equal(await restored.resume(), true);
      await network.idle();
      assert.equal(calls, 2);
      assert.deepEqual(view(restored.doc), {
        count: mode === "reject" ? 0 : mode === "transform" ? 5 : 10,
        items: mode === "reject" ? ["seed"] : [],
        body: mode === "reject" ? "😀" : "",
      });
      assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
      assert.deepEqual(restored.doc.checkpoint().snapshot, server.snapshot());
      assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
    }
  });

  it("queues listener edits behind existing pending work during rejected resubmission", async () => {
    const seen: number[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => {
      seen.push(batch.seq);
      return batch.seq === 1 ? [] : batch.operations;
    } });
    const network = createAsyncExampleNetwork(server);
    const original = network.connect("a");
    const peer = network.connect("b");
    original.disconnect();
    original.doc.state.count.value = 10;
    original.doc.transact(() => {
      original.doc.state.items.push("older");
      original.doc.state.body.insert(0, "older");
    });
    const restored = network.connect("a", roundTrip(original.doc.checkpoint()));
    let edited = false;
    const invalidResumes: Promise<void>[] = [];
    restored.doc.on("change", (event) => {
      if (event.origin === "server" && !edited) {
        edited = true;
        restored.doc.state.count.value = 30;
        invalidResumes.push(assert.rejects(restored.resume(), /must be idle/));
        assert.throws(() => restored.disconnect(), /during resume/);
      }
    });
    assert.equal(await restored.resume(), true);
    await network.idle();
    await Promise.all(invalidResumes);
    assert.equal(edited, true);
    assert.deepEqual(seen, [1, 2, 3]);
    assert.deepEqual(view(restored.doc), { count: 30, items: ["older"], body: "older" });
    assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
  });

  it("queues live commits after a paused catch-up prefix while both sides create listener edits", async () => {
    const entered = gate();
    const release = gate();
    const liveProcessed = gate();
    const seenA: number[] = [];
    const incomingA: number[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => {
      if (batch.clientId === "a") seenA.push(batch.seq);
      if (batch.clientId === "b" && batch.seq === 3) liveProcessed.resolve();
      return batch.operations;
    } });
    let pause = true;
    const network = createAsyncExampleNetwork(server, { transfer: async (direction, id, message) => {
      if (direction === "server-to-client" && id === "a") {
        incomingA.push(decodeServerCommit(Board, JSON.parse(message)).serverSeq);
        if (pause) { pause = false; entered.resolve(); await release.promise; }
      }
      return message;
    } });
    const original = network.connect("a");
    const peer = network.connect("b");
    original.disconnect();
    original.doc.state.items.push("pending");
    peer.doc.state.count.value = 1;
    await network.idle();
    peer.doc.state.count.value = 2;
    await network.idle();
    const restored = network.connect("a", roundTrip(original.doc.checkpoint()));
    let edited = false;
    restored.doc.on("change", (event) => {
      if (event.origin === "server" && !edited) {
        edited = true;
        restored.doc.state.count.value = 9;
      }
    });
    let peerEdited = false;
    peer.doc.on("change", (event) => {
      if (event.origin === "server" && event.commit.source.clientId === "a" && !peerEdited) {
        peerEdited = true;
        peer.doc.state.count.value = 11;
      }
    });
    const resumed = restored.resume();
    await entered.promise;
    peer.doc.state.count.value = 3;
    await liveProcessed.promise;
    assert.equal(server.snapshot().serverSeq, 3);
    assert.equal(restored.doc.checkpoint().snapshot.serverSeq, 0);
    assert.deepEqual(incomingA, [1]);
    release.resolve();
    assert.equal(await resumed, true);
    await network.idle();
    assert.equal(edited, true);
    assert.equal(peerEdited, true);
    assert.deepEqual(seenA, [1, 2]);
    assert.deepEqual(incomingA, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
    assert.deepEqual(restored.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
  });

  it("keeps pending work when disconnected during an in-flight request or acknowledgement", async () => {
    for (const pausedDirection of ["client-to-server", "server-to-client"] as const) {
      const entered = gate();
      const release = gate();
      let paused = false;
      const server = createServer(Board);
      const network = createAsyncExampleNetwork(server, { transfer: async (direction, id, message) => {
        if (id === "a" && direction === pausedDirection && !paused) {
          paused = true; entered.resolve(); await release.promise;
        }
        return message;
      } });
      const original = network.connect("a");
      const peer = network.connect("b");
      original.doc.state.count.value = 1;
      await entered.promise;
      original.doc.state.count.value = 2;
      original.disconnect();
      assert.throws(() => network.connect("a", original.doc.checkpoint()), /must be idle/);
      release.resolve();
      await network.idle();
      assert.equal(server.snapshot().serverSeq, 1);
      assert.equal(original.doc.checkpoint().snapshot.serverSeq, 0);
      assert.deepEqual(original.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [1, 2]);
      const checkpoint = roundTrip(original.doc.checkpoint());
      const restored = network.connect("a", checkpoint);
      assert.equal(await restored.resume(), true);
      await network.idle();
      assert.equal(server.snapshot().serverSeq, 2);
      assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
      assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
      assert.equal(original.doc.checkpoint().snapshot.serverSeq, 0);
      await assert.rejects(original.resume(), /replaced connection/);
    }
  });

  it("routes replay receipts only to the source and skips already-consumed commits", async () => {
    let calls = 0;
    let peerDeliveries = 0;
    const server = createServer(Board, { resolve: ({ batch }) => {
      calls++; return batch.operations;
    } });
    const network = createAsyncExampleNetwork(server, { transfer: async (direction, id, message) => {
      if (direction === "server-to-client" && id === "b") peerDeliveries++;
      return message;
    } });
    const original = network.connect("a");
    const peer = network.connect("b");
    original.disconnect();
    original.doc.state.count.value = 1;
    const checkpoint = roundTrip(original.doc.checkpoint());
    const batch = checkpoint.pendingBatches[0]!;
    server.receive(batch); // Lose the original broadcast.
    await network.submit(batch);
    await network.idle();
    assert.equal(peerDeliveries, 0);
    assert.equal(peer.doc.checkpoint().snapshot.serverSeq, 0);
    peer.disconnect();
    assert.equal(await peer.resume(), true);
    const restored = network.connect("a", checkpoint);
    assert.equal(await restored.resume(), true);
    const saved = server.checkpoint();
    await network.submit(batch);
    await network.idle();
    assert.equal(calls, 1);
    assert.equal(peerDeliveries, 1);
    assert.deepEqual(server.checkpoint(), saved);
    assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
    assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
  });

  it("returns false without submitting or replacing pending work when history is insufficient", async () => {
    let sourceSubmissions = 0;
    const server = createServer(Board, { historyLimit: 0 });
    const network = createAsyncExampleNetwork(server, { transfer: async (direction, id, message) => {
      if (direction === "client-to-server" && id === "a") sourceSubmissions++;
      return message;
    } });
    const original = network.connect("a");
    const peer = network.connect("b");
    original.disconnect();
    original.doc.state.count.value = 1;
    const checkpoint = roundTrip(original.doc.checkpoint());
    peer.doc.state.count.value = 2;
    await network.idle();
    const saved = server.checkpoint();
    const restored = network.connect("a", checkpoint);
    assert.equal(await restored.resume(), false);
    assert.deepEqual(restored.doc.checkpoint(), checkpoint);
    restored.doc.state.count.value = 3;
    assert.equal(await restored.resume(), false);
    await network.idle();
    assert.equal(sourceSubmissions, 0);
    assert.deepEqual(server.checkpoint(), saved);
    assert.deepEqual(restored.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [1, 2]);
  });

  it("stops on transfer, parse, decoder, resolver, receive and incoming listener errors", async () => {
    for (const kind of [
      "request transfer", "request parse", "request decode", "resolver",
      "commit transfer", "commit parse", "commit decode", "receive", "listener",
    ]) {
      const expected = new Error(kind + " failure");
      const server = createServer(Board, { resolve: ({ batch }) => {
        if (kind === "resolver") throw expected;
        if (kind === "listener") return [{ type: "value/set", path: "count", value: 2 }];
        return batch.operations;
      } });
      const network = createAsyncExampleNetwork(server, { transfer: async (direction, id, message) => {
        if (direction === "client-to-server") {
          if (kind === "request transfer") throw expected;
          if (kind === "request parse") return "{";
          if (kind === "request decode") return JSON.stringify({ ...JSON.parse(message), extra: true });
        } else if (id === "a") {
          if (kind === "commit transfer") throw expected;
          if (kind === "commit parse") return "{";
          if (kind === "commit decode") return JSON.stringify({ ...JSON.parse(message), extra: true });
          if (kind === "receive") return JSON.stringify({ ...JSON.parse(message), serverSeq: 2 });
        }
        return message;
      } });
      const source = network.connect("a");
      network.connect("b");
      source.doc.on("change", (event) => {
        if (kind === "listener" && event.origin === "server") throw expected;
      });
      source.doc.state.count.value = 1;
      const batch = source.doc.checkpoint().pendingBatches[0]!;
      let firstError: unknown;
      await assert.rejects(network.idle(), (error: unknown) => {
        firstError = error;
        if (kind.endsWith("parse")) assert.ok(error instanceof SyntaxError);
        else if (kind.endsWith("decode")) assert.ok(error instanceof WireDecodeError);
        else if (kind === "receive") assert.match(String(error), /Expected server sequence 1, received 2/);
        else assert.equal(error, expected);
        return true;
      });
      const checkpoint = roundTrip(source.doc.checkpoint());
      const completed = kind === "listener";
      assert.equal(checkpoint.snapshot.serverSeq, completed ? 1 : 0);
      assert.equal(checkpoint.pendingBatches.length, completed ? 0 : 1);
      assert.equal(server.snapshot().serverSeq, kind.startsWith("request") || kind === "resolver" ? 0 : 1);
      await assert.rejects(network.idle(), (error: unknown) => error === firstError);
      await assert.rejects(network.submit(batch), (error: unknown) => error === firstError);
      await assert.rejects(source.resume(), (error: unknown) => error === firstError);
      assert.throws(() => network.connect("c"), (error: unknown) => error === firstError);
    }
  });

  it("rejects resume and idle on failure even if an unrelated transfer gate is still paused", async () => {
    for (const rejectLate of [false, true]) {
      const entered = gate();
      const release = gate();
      const returned = gate();
      const expected = new Error("peer policy failure");
      const server = createServer(Board, { resolve: ({ batch }) => {
        if (batch.clientId === "b") throw expected;
        return batch.operations;
      } });
      const network = createAsyncExampleNetwork(server, { transfer: async (direction, id, message) => {
        if (direction === "server-to-client" && id === "a") {
          entered.resolve();
          try { await release.promise; }
          finally { returned.resolve(); }
        }
        return message;
      } });
      const original = network.connect("a");
      const peer = network.connect("b");
      original.disconnect();
      original.doc.state.count.value = 1;
      const checkpoint = roundTrip(original.doc.checkpoint());
      await network.submit(checkpoint.pendingBatches[0]!);
      await network.idle();
      const restored = network.connect("a", checkpoint);
      const resumed = restored.resume().then(() => assert.fail("resume should reject"), (error: unknown) => error);
      await entered.promise;
      const drained = network.idle().then(() => assert.fail("idle should reject"), (error: unknown) => error);
      peer.doc.state.count.value = 8;
      assert.equal(await resumed, expected);
      assert.equal(await drained, expected);
      assert.equal(restored.doc.checkpoint().snapshot.serverSeq, 0);
      assert.deepEqual(restored.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [1]);
      assert.equal(peer.doc.checkpoint().pendingBatches.length, 1);
      if (rejectLate) release.reject(new Error("late transfer failure"));
      else release.resolve();
      await returned.promise;
      assert.equal(restored.doc.checkpoint().snapshot.serverSeq, 0);
      assert.equal(server.snapshot().serverSeq, 1);
    }
  });
});
