import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createClient, createServer, decodeClientCheckpoint, WireDecodeError,
  type ClientBatch, type ClientCheckpoint, type DocumentOperation, type PendingReplayConflict,
} from "../src/index.ts";
import { PendingReplayError } from "../src/conflict.ts";
import { initialStates, replayPending } from "../src/state.ts";
import { Board, createExampleNetwork } from "../examples/resume.ts";
import { createAsyncExampleNetwork } from "../examples/async-resume.ts";
import { connectHttpExampleClient, startHttpExampleServer } from "../examples/http-sync.ts";
import { createCheckpointStore } from "../examples/persistent-resume.ts";

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;
type Checkpoint = ClientCheckpoint<Shape>;

function setup() {
  const batches: Batch[] = [];
  const doc = createClient(Board, { clientId: "a", onBatch: (batch) => batches.push(batch) });
  return { doc, batches };
}

function dependentEdits(doc: ReturnType<typeof setup>["doc"]): void {
  doc.transact(() => { doc.state.items.push("A"); doc.state.body.insert(0, "😀"); });
  doc.transact(() => { doc.state.items.push("B"); doc.state.body.insert(1, "B"); });
}

function frozen(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  assert.ok(Object.isFrozen(input));
  for (const value of Object.values(input)) frozen(value);
}

function invalid(input: unknown, path: string): void {
  const matches = (error: unknown) => error instanceof WireDecodeError && error.path === path;
  assert.throws(() => decodeClientCheckpoint(Board, input), matches);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
  assert.throws(() => createClient(Board, { clientId: "a", checkpoint: input as Checkpoint, onBatch() {} }), matches);
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("pending replay conflict", () => {
  it("records rejected insertion dependencies and continues receiving for List and Text", () => {
    for (const kind of ["list", "text"] as const) {
      for (const action of ["insert", "delete"] as const) {
        const { doc, batches } = setup();
        if (kind === "list") {
          doc.state.items.push("A");
          if (action === "insert") doc.state.items.push("B");
          else doc.state.items.delete(0);
        } else {
          doc.state.body.insert(0, "😀");
          if (action === "insert") doc.state.body.insert(1, "B");
          else doc.state.body.delete(0);
        }
        const server = createServer(Board, { resolve: ({ batch }) => batch.clientId === "a" ? [] : batch.operations });
        let changes = 0;
        doc.on("change", () => changes++);
        doc.receive(server.receive(batches[0]!).commit);
        const conflict: PendingReplayConflict<DocumentOperation<Shape>> | null = doc.replayConflict;
        assert.equal(conflict?.batch, batches[1]);
        assert.equal(conflict?.operationIndex, 0);
        assert.ok(conflict?.message.includes("Unknown"));
        frozen(conflict);
        assert.equal(changes, 1); // Even deleting A had already left the optimistic state empty.
        assert.deepEqual(doc.checkpoint().pendingBatches, [batches[1]]);
        assert.equal(doc.checkpoint().snapshot.serverSeq, 1);
        doc.receive(server.receive({ clientId: "peer", seq: 1,
          operations: [{ type: "value/set", path: "count", value: 7 }] }).commit);
        assert.equal(doc.state.count.value, 7);
        assert.equal(doc.replayConflict, conflict);
        doc.receive(server.receive(batches[1]!).commit);
        assert.equal(doc.replayConflict, null);
        assert.deepEqual(doc.checkpoint().pendingBatches, []);
        assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
      }
    }
  });

  it("retains complete batches only and resumes sequences and ID allocation after unblocking", () => {
    const { doc, batches } = setup();
    doc.state.items.push("A");
    doc.state.count.value = 9; // Replayable prefix.
    doc.transact(() => {
      doc.state.count.value = 77;
      doc.state.body.insert(0, "hidden");
      doc.state.items.push("B"); // Depends on rejected A.
    });
    doc.state.count.value = 99; // Must not replay past the failed batch.
    const server = createServer(Board, { resolve: ({ batch }) =>
      batch.clientId === "a" && (batch.seq === 1 || batch.seq === 3) ? [] : batch.operations });
    let changes = 0;
    doc.on("change", () => changes++);
    doc.receive(server.receive(batches[0]!).commit);
    assert.equal(doc.state.count.value, 9);
    assert.equal(doc.state.body.toString(), "");
    assert.deepEqual(doc.state.items.toArray(), []);
    assert.equal(doc.replayConflict?.batch, batches[2]);
    assert.equal(doc.replayConflict?.operationIndex, 2);
    const before = doc.checkpoint();
    let invoked = false;
    for (const mutate of [
      () => { doc.state.count.value = 3; }, () => doc.state.count.set(3),
      () => doc.state.items.push("x"), () => doc.state.items.insert(0, "x"),
      () => doc.state.body.insert(0, "x"),
      () => doc.transact(() => { invoked = true; }),
    ]) {
      assert.throws(mutate, /replay is blocked/);
      assert.deepEqual(doc.checkpoint(), before);
    }
    assert.equal(invoked, false);
    doc.state.body.insert(0, ""); doc.state.body.delete(0, 0);
    assert.deepEqual(doc.checkpoint(), before);
    doc.receive(server.receive({ clientId: "peer", seq: 1,
      operations: [{ type: "value/set", path: "count", value: 5 }] }).commit);
    assert.equal(changes, 1); // Prefix still shows 9; same conflict.
    doc.receive(server.receive(batches[1]!).commit);
    assert.equal(changes, 1); // Silent own ack, same conflicting batch.
    doc.receive(server.receive(batches[2]!).commit);
    assert.equal(doc.replayConflict, null);
    assert.equal(doc.state.count.value, 99);
    assert.equal(changes, 2);
    doc.receive(server.receive(batches[3]!).commit);
    assert.equal(changes, 2);
    doc.transact(() => { doc.state.items.push("new"); doc.state.body.insert(0, "😀"); });
    assert.equal(batches[4]!.seq, 5);
    const restored = createClient(Board, { clientId: "a", checkpoint: decodeClientCheckpoint(Board,
      JSON.parse(JSON.stringify(doc.checkpoint()))), onBatch() {} });
    assert.deepEqual(restored.checkpoint().lastBunchSeqs, { items: 2, body: 2 });
    for (const client of [doc, restored]) client.receive(server.receive(batches[4]!).commit);
    assert.equal(doc.state.body.toString(), "😀");
  });

  it("reports transformed Text dependencies and authoritative insert ID collisions", () => {
    const { doc, batches } = setup();
    doc.state.body.insert(0, "AB"); doc.state.body.delete(1);
    const insert = batches[0]!.operations[0]!;
    assert.equal(insert.type, "text/insert");
    const server = createServer(Board, { resolve: ({ batch }) => batch.seq === 1 && insert.type === "text/insert"
      ? [{ ...insert, value: "A" }] : [] });
    doc.receive(server.receive(batches[0]!).commit);
    assert.equal(doc.state.body.toString(), "A");
    assert.equal(doc.replayConflict?.batch, batches[1]);
    const before = doc.checkpoint();
    assert.throws(() => doc.state.body.delete(0), /replay is blocked/);
    assert.deepEqual(doc.checkpoint(), before);

    for (const kind of ["list", "text"] as const) {
      const local = setup();
      if (kind === "list") local.doc.state.items.push("A");
      else local.doc.state.body.insert(0, "😀");
      local.doc.receive({ serverSeq: 1, source: { clientId: "peer", seq: 1 },
        operations: local.batches[0]!.operations });
      assert.match(local.doc.replayConflict!.message, /Duplicate/);
      const localBefore = local.doc.checkpoint();
      assert.throws(() => kind === "list" ? local.doc.state.items.delete(0) : local.doc.state.body.delete(0),
        /replay is blocked/);
      assert.deepEqual(local.doc.checkpoint(), localBefore);
      const cp = decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(local.doc.checkpoint())));
      const restored = createClient(Board, { clientId: "a", checkpoint: cp, onBatch() {} });
      assert.deepEqual(restored.replayConflict, local.doc.replayConflict);
      local.doc.receive({ serverSeq: 2, source: { clientId: "a", seq: 1 }, operations: [] });
      assert.equal(local.doc.replayConflict, null);
    }
  });

  it("notifies conflict transitions without value changes and commits before a listener throws", () => {
    const { doc, batches } = setup();
    doc.state.items.push("A"); doc.state.items.delete(0);
    doc.state.items.push("B"); doc.state.items.delete(0);
    const server = createServer(Board, { resolve: () => [] });
    const seen: Array<number | null> = [];
    const unsubscribe = doc.on("change", () => seen.push(doc.replayConflict?.batch.seq ?? null));
    doc.receive(server.receive(batches[0]!).commit);
    doc.receive(server.receive({ clientId: "peer", seq: 1,
      operations: [{ type: "value/set", path: "count", value: 0 }] }).commit);
    assert.deepEqual(seen, [2]);
    doc.receive(server.receive(batches[1]!).commit);
    assert.equal(doc.replayConflict, null); // B + delete B is now a valid prefix.
    doc.receive(server.receive(batches[2]!).commit);
    assert.deepEqual(seen, [2, null, 4]);
    unsubscribe();
    const error = new Error("listener failed");
    doc.on("change", () => { throw error; });
    assert.throws(() => doc.receive(server.receive(batches[3]!).commit), (actual) => actual === error);
    assert.equal(doc.replayConflict, null);
    assert.equal(doc.checkpoint().snapshot.serverSeq, 5);
    assert.deepEqual(doc.checkpoint().pendingBatches, []);
  });

  it("keeps protocol and unexpected failures atomic rather than classifying them as blocked", () => {
    const { doc, batches } = setup(); dependentEdits(doc);
    const server = createServer(Board, { resolve: () => [] });
    doc.receive(server.receive(batches[0]!).commit);
    const before = doc.checkpoint(); const conflict = doc.replayConflict;
    for (const commit of [
      { serverSeq: 1, source: { clientId: "peer", seq: 1 }, operations: [] },
      { serverSeq: 3, source: { clientId: "peer", seq: 1 }, operations: [] },
      { serverSeq: 2, source: { clientId: "a", seq: 9 }, operations: [] },
      { serverSeq: 2, source: { clientId: "peer", seq: 1 }, operations: [{ type: "bad", path: "count" }] },
      { serverSeq: 2, source: { clientId: "peer", seq: 1 }, operations: batches[1]!.operations },
    ]) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
      assert.throws(() => doc.receive(commit as Parameters<typeof doc.receive>[0]));
      assert.deepEqual(doc.checkpoint(), before);
      assert.equal(doc.replayConflict, conflict);
    }
    assert.throws(() => replayPending(initialStates(Board, undefined), [{ clientId: "a", seq: 1,
      operations: [{ type: "value/set", path: "missing", value: 1 }] }]), (error) =>
      error instanceof PendingReplayError && error.operationIndex === 0 && /Unknown document path/.test(error.message));
  });

  it("notifies when the first conflict moves to another batch without visible changes", () => {
    const base = setup().doc.checkpoint();
    const unknown = { bunchId: "unknown", counter: 0 };
    const pending: Batch[] = [1, 2].map((seq) => ({ clientId: "a", seq,
      operations: [{ type: "list/delete", path: "items", id: unknown }] }));
    const doc = createClient(Board, { clientId: "a", onBatch() {}, checkpoint: {
      ...base, lastLocalSeq: 2, pendingBatches: pending,
    } });
    const seen: Array<number | null> = [];
    doc.on("change", () => seen.push(doc.replayConflict?.batch.seq ?? null));
    doc.receive({ serverSeq: 1, source: { clientId: "a", seq: 1 }, operations: [] });
    assert.deepEqual(seen, [2]);
    assert.deepEqual(doc.state.items.toArray(), []);
    doc.receive({ serverSeq: 2, source: { clientId: "a", seq: 2 }, operations: [] });
    assert.deepEqual(seen, [2, null]);
  });

  it("restores blocked checkpoints silently and deeply owns the complete pending suffix", () => {
    const { doc, batches } = setup(); dependentEdits(doc);
    doc.state.count.value = 3;
    const server = createServer(Board, { resolve: () => [] });
    doc.receive(server.receive(batches[0]!).commit);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Known JSON fixture is made mutable to verify ownership or inject corruption; production decoders are tested separately.
    const input = JSON.parse(JSON.stringify(doc.checkpoint())) as Mutable<Checkpoint>;
    const cp = decodeClientCheckpoint(Board, input); frozen(cp);
    const restored = createClient(Board, { clientId: "a", checkpoint: cp,
      onBatch: () => assert.fail("restore cannot send") });
    assert.deepEqual(restored.replayConflict, doc.replayConflict);
    assert.equal(restored.state.count.value, 0);
    assert.ok(input.pendingBatches[0]!.operations[0]!.type === "list/insert");
    assert.ok(input.pendingBatches[1]!.operations[0]!.type === "value/set");
    input.pendingBatches[0]!.operations[0]!.value = "changed";
    input.pendingBatches[1]!.operations[0]!.value = 99;
    input.snapshot.data.count = 99;
    assert.deepEqual(restored.checkpoint(), cp);
    for (const mutate of [
      (parsed: typeof input) => { Object.assign(parsed.pendingBatches[1]!.operations[0]!, { extra: true }); },
      (parsed: typeof input) => { parsed.pendingBatches[1]!.seq = 99; },
    ]) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Known JSON fixture is made mutable to verify ownership or inject corruption; production decoders are tested separately.
      const parsed = JSON.parse(JSON.stringify(cp)) as Mutable<Checkpoint>; mutate(parsed);
      invalid(parsed, "extra" in parsed.pendingBatches[1]!.operations[0]!
        ? "/pendingBatches/1/operations/0/extra" : "/pendingBatches/1/seq");
    }
    restored.receive(server.receive(batches[1]!).commit);
    assert.equal(restored.replayConflict, null);
    assert.equal(restored.state.count.value, 3);
  });

  it("rejects overlapping pending ranges even after a conflict, and streams huge unknown deletes", () => {
    const { doc } = setup(); dependentEdits(doc);
    const cp = doc.checkpoint();
    const first = cp.pendingBatches[0]!, second = cp.pendingBatches[1]!;
    const unknown = { bunchId: "unknown", counter: 0 };
    const blocked = { ...cp, pendingBatches: [{ ...first, operations: [{
      type: "text/delete", path: "body", ranges: [{ start: unknown, count: Number.MAX_SAFE_INTEGER }],
    }] }, second] };
    const decoded = decodeClientCheckpoint(Board, blocked);
    assert.equal(createClient(Board, { clientId: "a", checkpoint: decoded, onBatch() {} }).replayConflict?.operationIndex, 0);
    const textInsert = second.operations[1]!;
    assert.equal(textInsert.type, "text/insert");
    if (textInsert.type !== "text/insert") return;
    invalid({ ...blocked, lastLocalSeq: 3, pendingBatches: [...blocked.pendingBatches,
      { ...second, seq: 3, operations: [{ ...textInsert, value: "XY" }] }] },
      "/pendingBatches/2/operations/0");
    invalid({ ...blocked, lastLocalSeq: 3, pendingBatches: [blocked.pendingBatches[0],
      { ...second, operations: [{ ...textInsert, value: "XY" }] },
      { ...second, seq: 3, operations: [{ ...textInsert,
        id: { ...textInsert.id, counter: textInsert.id.counter + 1 }, value: "Z" }] }] },
      "/pendingBatches/2/operations/0");
    invalid({ ...blocked, pendingBatches: [blocked.pendingBatches[0], { ...second, operations: [{
      ...textInsert, id: { ...textInsert.id, bunchId: "foreign" },
    }] }] }, "/pendingBatches/1/operations/0/id/bunchId");
    invalid({ ...blocked, lastBunchSeqs: { items: 0, body: 0 } }, "/lastBunchSeqs/items");
  });
});

describe("blocked resume examples", { timeout: 15_000 }, () => {
  it("keeps synchronous resume offline on conflict and finishes transiently blocked catch-up", () => {
    for (const confirmSecond of [false, true]) {
      const server = createServer(Board, { resolve: ({ batch }) => batch.clientId === "a" ? [] : batch.operations });
      const network = createExampleNetwork(server);
      const source = network.connect("a"); const peer = network.connect("b");
      source.disconnect(); dependentEdits(source.doc);
      const pending = source.doc.checkpoint().pendingBatches;
      network.submit(pending[0]!);
      if (confirmSecond) network.submit(pending[1]!);
      assert.equal(source.resume(), confirmSecond);
      assert.equal(source.doc.checkpoint().snapshot.serverSeq, confirmSecond ? 2 : 1);
      peer.doc.state.count.value = 7; // Conflict never stops the network.
      if (!confirmSecond) {
        assert.equal(source.resume(), false);
        network.submit(pending[1]!);
        assert.equal(source.resume(), true);
      }
      source.doc.state.count.value = 8;
      assert.deepEqual(source.doc.checkpoint().pendingBatches, []);
    }
  });

  it("skips stale synchronous live jobs and resumes pumping after peer commits unblock them", () => {
    const resolved: string[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => {
      resolved.push(batch.clientId + ":" + batch.seq);
      return batch.clientId === "a" && batch.seq <= 2 ? [] : batch.operations;
    } });
    const network = createExampleNetwork(server);
    const a = network.connect("a"), b = network.connect("b");
    let edited = false;
    let seed!: Batch;
    b.doc.on("change", (event) => {
      if (event.origin === "server" && !edited) {
        edited = true; dependentEdits(a.doc); // Both batches queue behind the current broadcast.
        seed = a.doc.checkpoint().pendingBatches[0]!;
      }
    });
    network.submit({ clientId: "kick", seq: 1,
      operations: [{ type: "value/set", path: "count", value: 1 }] });
    assert.equal(a.doc.replayConflict?.batch.seq, 2);
    assert.deepEqual(resolved, ["kick:1", "a:1"]);
    b.doc.state.count.value = 2;
    assert.equal(a.doc.state.count.value, 2);
    network.submit({ clientId: "seed", seq: 1, operations: seed.operations });
    assert.equal(a.doc.replayConflict, null);
    a.doc.state.count.value = 3;
    assert.deepEqual(resolved, ["kick:1", "a:1", "b:1", "seed:1", "a:2", "a:3"]);
  });

  it("keeps async peers live, saves blocked state, and restarts automatic pumping on unblock", async () => {
    const saved: Checkpoint[] = [];
    const resolved: string[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => {
      resolved.push(batch.clientId + ":" + batch.seq);
      return batch.clientId === "a" && batch.seq === 1 ? [] : batch.operations;
    } });
    const network = createAsyncExampleNetwork(server, { saveClientCheckpoint: (cp) => { saved.push(cp); } });
    const a = network.connect("a"), b = network.connect("b");
    dependentEdits(a.doc);
    a.doc.state.count.value = 3;
    await network.idle();
    assert.equal(a.doc.replayConflict?.batch.seq, 2);
    assert.deepEqual(resolved, ["a:1"]);
    const cp = saved.filter((entry) => entry.clientId === "a").at(-1)!;
    assert.equal(cp.snapshot.serverSeq, 1);
    assert.ok(createClient(Board, { clientId: "a", checkpoint: decodeClientCheckpoint(Board,
      JSON.parse(JSON.stringify(cp))), onBatch() {} }).replayConflict);
    b.doc.state.count.value = 7;
    await network.idle();
    assert.equal(a.doc.state.count.value, 7);
    // Explicit application action introduces A's old IDs; no automatic rebase or repair.
    const seed = saved.find((entry) => entry.clientId === "a" && entry.lastLocalSeq === 1)!.pendingBatches[0]!;
    await network.submit({ clientId: "seed", seq: 1, operations: seed.operations });
    await network.idle();
    assert.equal(a.doc.replayConflict, null);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
    assert.deepEqual(resolved, ["a:1", "b:1", "seed:1", "a:2", "a:3"]);
  });

  it("checks async blocked state again before applying a paused automatic send", async (t) => {
    const entered = gate(), release = gate(); t.after(() => release.resolve());
    const server = createServer(Board);
    const network = createAsyncExampleNetwork(server, { transfer: async (direction, clientId, message) => {
      if (direction === "client-to-server" && clientId === "a") { entered.resolve(); await release.promise; }
      return message;
    } });
    const a = network.connect("a"), b = network.connect("b");
    a.doc.state.items.push("A");
    await entered.promise;
    await network.submit({ clientId: "seed", seq: 1,
      operations: a.doc.checkpoint().pendingBatches[0]!.operations });
    // Incoming delivery must complete before releasing a's queued submission.
    const seen = new Promise<void>((resolve) => {
      if (a.doc.replayConflict !== null) resolve();
      else a.doc.on("change", () => { if (a.doc.replayConflict !== null) resolve(); });
    });
    await seen; release.resolve(); await network.idle();
    assert.equal(server.snapshot().serverSeq, 1);
    assert.equal(a.doc.checkpoint().pendingBatches.length, 1);
    assert.equal(b.doc.state.items.get(0), "A");
    assert.equal(await a.resume(), false);
  });

  it("finishes async catch-up before reporting conflict, without resending confirmed batches", async () => {
    for (const confirmSecond of [false, true]) {
      const resolved: number[] = [];
      const server = createServer(Board, { resolve: ({ batch }) => { resolved.push(batch.seq); return []; } });
      const network = createAsyncExampleNetwork(server);
      const a = network.connect("a"); a.disconnect(); dependentEdits(a.doc);
      const pending = a.doc.checkpoint().pendingBatches;
      await network.submit(pending[0]!);
      if (confirmSecond) await network.submit(pending[1]!);
      await network.idle();
      assert.equal(await a.resume(), confirmSecond);
      await network.idle();
      assert.deepEqual(resolved, confirmSecond ? [1, 2] : [1]);
      if (!confirmSecond) {
        await network.submit(pending[1]!); await network.idle();
        assert.equal(await a.resume(), true); await network.idle();
      }
      assert.equal(a.doc.replayConflict, null);
    }
  });

  it("saves blocked HTTP checkpoints, polls again after false, and processes transient conflicts", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "articollab-blocked-http-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = createCheckpointStore(directory);
    const resolved: number[] = [];
    const server = createServer(Board, { resolve: ({ batch }) => { resolved.push(batch.seq); return []; } });
    const host = await startHttpExampleServer(server, { saveServerCheckpoint: store.saveServer });
    t.after(() => host.close());
    const a = await connectHttpExampleClient(host.url, "a", { saveClientCheckpoint: store.saveClient });
    dependentEdits(a.doc);
    const before = store.loadClient("a")!;
    assert.equal(await a.sync(), false);
    assert.deepEqual(resolved, [1]);
    const blocked = store.loadClient("a")!;
    assert.equal(blocked.snapshot.serverSeq, 1);
    assert.equal(blocked.pendingBatches.length, 1);
    const restored = await connectHttpExampleClient(host.url, "a", { checkpoint: blocked, saveClientCheckpoint: store.saveClient });
    assert.equal(await restored.sync(), false);
    assert.deepEqual(resolved, [1]);
    const response = await fetch(host.url + "/batches", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(blocked.pendingBatches[0]) });
    assert.equal(response.status, 204); await response.text();
    assert.equal(await restored.sync(), true);
    assert.equal(store.loadClient("a")!.pendingBatches.length, 0);
    // Old checkpoint catches both commits in one response: blocked -> ready.
    const late = await connectHttpExampleClient(host.url, "a", { checkpoint: before });
    assert.equal(await late.sync(), true);
    assert.equal(late.doc.replayConflict, null);
    assert.deepEqual(resolved, [1, 2]);
    late.doc.state.count.value = 3;
    assert.equal(await late.sync(), true);
    assert.deepEqual(resolved, [1, 2, 3]);
  });
});
