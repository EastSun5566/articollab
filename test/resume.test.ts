import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { Board, createExampleNetwork } from "../examples/resume.ts";
import {
  createServer,
  decodeClientCheckpoint,
  decodeServerCheckpoint,
  type ClientBatch,
  type ClientCheckpoint,
  type ClientDocument,
  type DocumentOperation,
} from "../src/index.ts";

type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;

function roundTrip(checkpoint: ClientCheckpoint<Shape>): ClientCheckpoint<Shape> {
  return decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(checkpoint)));
}

function view(doc: ClientDocument<Shape>) {
  return {
    count: doc.state.count.value,
    items: doc.state.items.toArray(),
    body: doc.state.body.toString(),
  };
}

describe("in-memory resume example", () => {
  it("has no demo side effects when imported", () => {
    const url = new URL("../examples/resume.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, [
      "--input-type=module", "-e", "await import(" + JSON.stringify(url) + ")",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("catches up a lost acknowledgement, drains mixed pending work without change events, then goes live", () => {
    const received: string[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => {
      received.push(batch.clientId + ":" + batch.seq);
      return batch.operations;
    } });
    const network = createExampleNetwork(server);
    const original = network.connect();
    const peer = network.connect();
    original.disconnect();
    original.doc.transact(() => {
      original.doc.state.count.value = 1;
      original.doc.state.items.push("saved");
      original.doc.state.body.insert(0, "A😀");
    });
    original.doc.transact(() => {
      original.doc.state.count.value = 2;
      original.doc.state.items.push("unsent");
      original.doc.state.body.insert(2, "!");
    });
    const checkpoint = roundTrip(original.doc.checkpoint());
    network.submit(checkpoint.pendingBatches[0]!);
    peer.doc.state.count.value = 7;
    const restored = network.connect(checkpoint);
    let changes = 0;
    restored.doc.on("change", () => changes++);
    assert.deepEqual(received, ["client-1:1", "client-2:1"]);
    assert.deepEqual(view(restored.doc), { count: 2, items: ["saved", "unsent"], body: "A😀!" });
    assert.equal(restored.resume(), true);
    assert.equal(changes, 0); // Own acks still remove pending batches.
    assert.deepEqual(received, ["client-1:1", "client-2:1", "client-1:2"]);
    assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
    assert.deepEqual(view(restored.doc), view(peer.doc));
    assert.deepEqual(restored.doc.checkpoint().snapshot, server.snapshot());

    restored.doc.transact(() => {
      restored.doc.state.items.push("live");
      restored.doc.state.body.insert(3, "B");
    });
    assert.deepEqual(received, ["client-1:1", "client-2:1", "client-1:2", "client-1:3"]);
    assert.deepEqual(restored.doc.checkpoint().lastBunchSeqs, { items: 2, body: 2 });
    assert.deepEqual(view(restored.doc), view(peer.doc));
    assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(checkpoint.pendingBatches.map((batch) => batch.seq), [1, 2]);
  });


  it("resumes after both server and client checkpoints have been restored from JSON", () => {
    const originalServer = createServer(Board);
    const originalNetwork = createExampleNetwork(originalServer);
    const original = originalNetwork.connect();
    const peer = originalNetwork.connect();
    original.doc.transact(() => {
      original.doc.state.count.value = 1;
      original.doc.state.items.push("seed");
      original.doc.state.body.insert(0, "😀");
    });
    original.disconnect();
    original.doc.transact(() => {
      original.doc.state.items.delete(0);
      original.doc.state.body.delete(0);
    });
    original.doc.transact(() => {
      original.doc.state.count.value = 3;
      original.doc.state.items.push("restored");
      original.doc.state.body.insert(0, "B😀");
    });
    const clientCheckpoint = roundTrip(original.doc.checkpoint());
    originalNetwork.submit(clientCheckpoint.pendingBatches[0]!);
    peer.disconnect();
    const peerCheckpoint = roundTrip(peer.doc.checkpoint());
    let calls = 0;
    const server = createServer(Board, {
      checkpoint: decodeServerCheckpoint(
        Board, JSON.parse(JSON.stringify(originalServer.checkpoint()))
      ),
      resolve: ({ batch }) => { calls++; return batch.operations; },
    });
    const network = createExampleNetwork(server);
    const restoredPeer = network.connect(peerCheckpoint);
    assert.equal(restoredPeer.resume(), true);
    const restored = network.connect(clientCheckpoint);
    assert.equal(restored.resume(), true);
    assert.equal(calls, 1); // Catch-up uses the saved result, not the new resolver.
    assert.deepEqual(view(restored.doc), { count: 3, items: ["restored"], body: "B😀" });
    assert.deepEqual(restored.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(restoredPeer.doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
    assert.equal(server.snapshot().serverSeq, 3);
  });

  it("does not retry older batches when catch-up already includes every pending batch", () => {
    let calls = 0;
    const server = createServer(Board, { resolve: ({ batch }) => {
      calls++;
      return batch.operations;
    } });
    const network = createExampleNetwork(server);
    const original = network.connect();
    const peer = network.connect();
    original.disconnect();
    for (const value of [1, 2, 3]) original.doc.state.count.value = value;
    const checkpoint = roundTrip(original.doc.checkpoint());
    for (const batch of checkpoint.pendingBatches) network.submit(batch);
    assert.equal(server.checkpoint().clients[0]!.replay!.batch.seq, 3);
    const restored = network.connect(checkpoint);
    assert.equal(restored.resume(), true);
    assert.equal(calls, 3);
    assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
    assert.deepEqual(view(restored.doc), view(peer.doc));
    restored.doc.state.count.value = 4;
    assert.equal(calls, 4);
    assert.equal(server.checkpoint().clients[0]!.replay!.batch.seq, 4);
  });

  it("uses accepted, rejected and transformed results without rerunning policy during catch-up", () => {
    for (const mode of ["accept", "reject", "transform"] as const) {
      let calls = 0;
      const server = createServer(Board, { resolve: ({ batch }) => {
        calls++;
        if (batch.seq === 1 || mode === "accept") return batch.operations;
        if (mode === "reject") return [];
        return batch.operations.map((operation) => operation.type === "value/set"
          ? { ...operation, value: 5 } : operation);
      } });
      const network = createExampleNetwork(server);
      const original = network.connect();
      original.doc.transact(() => {
        original.doc.state.items.push("saved");
        original.doc.state.body.insert(0, "😀");
      });
      const peer = network.connect();
      original.disconnect();
      original.doc.transact(() => {
        original.doc.state.count.value = 10;
        original.doc.state.items.delete(0);
        original.doc.state.body.delete(0);
      });
      const checkpoint = roundTrip(original.doc.checkpoint());
      network.submit(checkpoint.pendingBatches[0]!);
      const restored = network.connect(checkpoint);
      assert.equal(restored.resume(), true);
      assert.equal(calls, 2);
      assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
      assert.deepEqual(view(restored.doc), {
        count: mode === "reject" ? 0 : mode === "transform" ? 5 : 10,
        items: mode === "reject" ? ["saved"] : [],
        body: mode === "reject" ? "😀" : "",
      });
      assert.deepEqual(view(restored.doc), view(peer.doc));
      assert.deepEqual(restored.doc.checkpoint().snapshot, server.snapshot());
    }
  });

  it("buffers catch-up listener edits and queues peer edits after the current broadcast", () => {
    const received: string[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => {
      received.push(batch.clientId + ":" + batch.seq);
      return batch.operations;
    } });
    const network = createExampleNetwork(server);
    const original = network.connect();
    const peer = network.connect();
    original.disconnect();
    original.doc.state.items.push("pending");
    peer.doc.state.count.value = 7;
    const restored = network.connect(roundTrip(original.doc.checkpoint()));
    let edited = false;
    restored.doc.on("change", (event) => {
      if (event.origin === "server" && !edited) {
        edited = true;
        restored.doc.state.count.value = 9; // a:2 must wait for a:1.
      }
    });
    let peerEdited = false;
    peer.doc.on("change", (event) => {
      if (event.origin === "server" && !peerEdited) {
        peerEdited = true;
        peer.doc.state.count.value = 11;
      }
    });
    assert.equal(restored.resume(), true);
    assert.equal(edited, true);
    assert.equal(peerEdited, true);
    assert.deepEqual(received, ["client-2:1", "client-1:1", "client-2:2", "client-1:2"]);
    assert.deepEqual(view(restored.doc), { count: 9, items: ["pending"], body: "" });
    assert.deepEqual(view(restored.doc), view(peer.doc));
    assert.equal(restored.doc.checkpoint().snapshot.serverSeq, 4);
    assert.equal(peer.doc.checkpoint().snapshot.serverSeq, 4);
  });

  it("selects pending again after a rejection listener creates a newer batch", () => {
    const received: string[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => {
      received.push(batch.clientId + ":" + batch.seq);
      return batch.clientId === "client-1" && batch.seq === 1 ? [] : batch.operations;
    } });
    const network = createExampleNetwork(server);
    const original = network.connect();
    const peer = network.connect();
    original.disconnect();
    original.doc.state.count.value = 10;
    original.doc.state.items.push("older pending");
    const restored = network.connect(roundTrip(original.doc.checkpoint()));
    let edited = false;
    restored.doc.on("change", (event) => {
      if (event.origin === "server" && !edited) {
        edited = true;
        restored.doc.state.count.value = 30; // a:3 must not overtake a:2.
        assert.throws(() => restored.resume(), /queue is draining/);
      }
    });
    assert.equal(restored.resume(), true);
    assert.equal(edited, true);
    assert.deepEqual(received, ["client-1:1", "client-1:2", "client-1:3"]);
    assert.deepEqual(view(restored.doc), { count: 30, items: ["older pending"], body: "" });
    assert.deepEqual(view(restored.doc), view(peer.doc));
    assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
  });

  it("finishes the entire catch-up before processing peer work created by a catch-up listener", () => {
    const server = createServer(Board);
    const network = createExampleNetwork(server);
    const original = network.connect();
    const peer = network.connect();
    original.disconnect();
    peer.doc.state.count.value = 1;
    peer.doc.state.count.value = 2;
    const restored = network.connect(roundTrip(original.doc.checkpoint()));
    const observed: number[] = [];
    restored.doc.on("change", (event) => {
      if (event.origin !== "server") return;
      observed.push(event.commit.serverSeq);
      if (event.commit.serverSeq === 1) peer.doc.state.count.value = 3;
    });
    assert.equal(restored.resume(), true);
    assert.deepEqual(observed, [1, 2, 3]);
    assert.deepEqual(view(restored.doc), view(peer.doc));
    assert.deepEqual(restored.doc.checkpoint().snapshot, server.snapshot());
  });

  it("routes retries only to the source and skips receipts already consumed", () => {
    let calls = 0;
    const server = createServer(Board, { resolve: ({ batch }) => {
      calls++;
      return batch.operations;
    } });
    const network = createExampleNetwork(server);
    const original = network.connect();
    const peer = network.connect();
    original.disconnect();
    original.doc.state.count.value = 1;
    const checkpoint = roundTrip(original.doc.checkpoint());
    const batch = checkpoint.pendingBatches[0]!;
    server.receive(batch); // The original broadcast is lost.
    network.submit(batch);
    assert.equal(peer.doc.checkpoint().snapshot.serverSeq, 0);
    peer.disconnect();
    assert.equal(peer.resume(), true); // Peers need catch-up, not the retry receipt.
    const serverCheckpoint = server.checkpoint();
    network.submit(batch);
    assert.deepEqual(server.checkpoint(), serverCheckpoint);
    const restored = network.connect(checkpoint);
    assert.equal(restored.resume(), true);
    const sourceCheckpoint = restored.doc.checkpoint();
    const peerCheckpoint = peer.doc.checkpoint();
    network.submit(batch);
    assert.equal(calls, 1);
    assert.deepEqual(restored.doc.checkpoint(), sourceCheckpoint);
    assert.deepEqual(peer.doc.checkpoint(), peerCheckpoint);
    assert.deepEqual(server.checkpoint(), serverCheckpoint);
  });

  it("keeps pending work disconnected when retained history cannot fill the gap", () => {
    let calls = 0;
    const server = createServer(Board, { historyLimit: 0, resolve: ({ batch }) => {
      calls++;
      return batch.operations;
    } });
    const network = createExampleNetwork(server);
    const original = network.connect();
    const peer = network.connect();
    original.disconnect();
    original.doc.state.count.value = 1;
    const checkpoint = roundTrip(original.doc.checkpoint());
    peer.doc.state.count.value = 2;
    const serverCheckpoint = server.checkpoint();
    const restored = network.connect(checkpoint);
    assert.equal(restored.resume(), false);
    assert.deepEqual(restored.doc.checkpoint(), checkpoint);
    restored.doc.state.count.value = 3;
    assert.equal(restored.resume(), false);
    assert.equal(calls, 1);
    assert.deepEqual(server.checkpoint(), serverCheckpoint);
    assert.deepEqual(restored.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [1, 2]);
    assert.equal(restored.doc.checkpoint().snapshot.serverSeq, 0);
  });

  it("stops on resolver failure without rolling back completed commits or losing pending work", () => {
    const received: number[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => {
      received.push(batch.seq);
      if (batch.seq === 2) throw new Error("policy failure");
      return batch.operations;
    } });
    const network = createExampleNetwork(server);
    const original = network.connect();
    network.connect();
    original.disconnect();
    original.doc.state.count.value = 1;
    original.doc.state.count.value = 2;
    const restored = network.connect(roundTrip(original.doc.checkpoint()));
    assert.throws(() => restored.resume(), /policy failure/);
    const latest = roundTrip(restored.doc.checkpoint());
    assert.equal(latest.snapshot.serverSeq, 1);
    assert.equal(latest.snapshot.data.count, 1);
    assert.equal(restored.doc.state.count.value, 2);
    assert.deepEqual(latest.pendingBatches.map((batch) => batch.seq), [2]);
    assert.throws(() => restored.resume(), /network stopped/);
    assert.throws(() => network.submit(latest.pendingBatches[0]!), /network stopped/);
    assert.throws(() => network.connect(), /network stopped/);
    assert.deepEqual(received, [1, 2]);
    assert.equal(server.snapshot().serverSeq, 1);
  });

  it("stops a failed delivery and cancels queued peer work while retaining document checkpoints", () => {
    const received: string[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => {
      received.push(batch.clientId + ":" + batch.seq);
      return batch.operations;
    } });
    const network = createExampleNetwork(server);
    const original = network.connect();
    const peer = network.connect();
    original.disconnect();
    original.doc.state.count.value = 1;
    original.doc.state.count.value = 2;
    const restored = network.connect(roundTrip(original.doc.checkpoint()));
    peer.doc.on("change", (event) => {
      if (event.origin === "server") {
        peer.doc.state.count.value = 9;
        throw new Error("listener failure");
      }
    });
    assert.throws(() => restored.resume(), /listener failure/);
    assert.deepEqual(received, ["client-1:1"]);
    assert.equal(server.snapshot().serverSeq, 1);
    const sourceCheckpoint = roundTrip(restored.doc.checkpoint());
    const peerCheckpoint = roundTrip(peer.doc.checkpoint());
    assert.equal(sourceCheckpoint.snapshot.serverSeq, 1);
    assert.deepEqual(sourceCheckpoint.pendingBatches.map((batch) => batch.seq), [2]);
    assert.equal(peerCheckpoint.snapshot.serverSeq, 1);
    assert.deepEqual(peerCheckpoint.pendingBatches.map((batch) => batch.seq), [1]);
    assert.equal(restored.doc.state.count.value, 2);
    assert.equal(peer.doc.state.count.value, 9);
    assert.throws(() => network.submit(peerCheckpoint.pendingBatches[0]!), /network stopped/);
    assert.deepEqual(received, ["client-1:1"]);
  });

  it("lets the runtime reject future gaps and stops the network", () => {
    const server = createServer(Board);
    const network = createExampleNetwork(server);
    const source = network.connect();
    const peer = network.connect();
    const missed: Batch = {
      clientId: server.openClient(), seq: 1,
      operations: [{ type: "value/set", path: "count", value: 4 }],
    };
    server.receive(missed); // Bypass routing to deliberately create a gap.
    assert.throws(() => { source.doc.state.count.value = 3; },
      /Expected server sequence 1, received 2/);
    assert.equal(server.snapshot().serverSeq, 2);
    const checkpoint = roundTrip(source.doc.checkpoint());
    assert.equal(checkpoint.snapshot.serverSeq, 0);
    assert.deepEqual(checkpoint.pendingBatches.map((batch) => batch.seq), [1]);
    assert.equal(source.doc.state.count.value, 3);
    assert.equal(peer.doc.state.count.value, 0);
    assert.throws(() => source.resume(), /network stopped/);
  });
});
