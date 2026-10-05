import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient, createServer, decodeClientBatch, decodeClientCheckpoint,
  decodeServerCheckpoint, decodeServerCommit, decodeSnapshot,
  defineDocument, list, text, value,
  type ClientBatch, type ClientCheckpoint, type ClientDocument,
  type DocumentOperation, type DocumentSnapshot, type ServerCommit, type ServerResolver,
} from "../src/index.ts";

const Board = defineDocument({ count: value(0), items: list<string>(), body: text() });
type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;
type Commit = ServerCommit<DocumentOperation<Shape>>;
type Mode = "accept" | "policy-reject" | "transform" | "explicit-reject";

function json(input: unknown): unknown { return JSON.parse(JSON.stringify(input)); }

function visible(doc: ClientDocument<Shape>) {
  return { count: doc.state.count.value, items: doc.state.items.toArray(), body: doc.state.body.toString() };
}

function transformed(batch: Batch): readonly DocumentOperation<Shape>[] {
  return batch.operations.map((operation) => {
    switch (operation.type) {
      case "value/set": return { ...operation, value: -operation.value - 1000 };
      case "list/insert": return { ...operation, value: "server:" + operation.value };
      // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
      case "text/insert": return { ...operation, value: [...operation.value].map((cp) => cp === "a" ? "A" : cp).join("") };
      default: return operation;
    }
  });
}

// Test-local scheduler records protocol facts, not an alternative IdList implementation.
function setup(historyLimit = 1000) {
  const trace: string[] = [];
  const coverage = new Set<string>();
  const commits: Commit[] = [];
  const snapshots: DocumentSnapshot<Shape>[] = [];
  const latest = new Map<string, { batch: Batch; commit: Commit }>();
  const insertionIds = new Set<string>();
  let mode: Mode | "throw" = "accept";
  let calls = 0;
  let expectedCalls = 0;
  const policyError = new Error("injected resolver failure");
  const resolve: ServerResolver<Shape> = ({ batch }) => {
    calls++;
    if (mode === "throw") throw policyError;
    if (mode === "policy-reject") return [];
    return mode === "transform" ? transformed(batch) : batch.operations;
  };
  let server = createServer(Board, { historyLimit, resolve });
  snapshots.push(decodeSnapshot(Board, json(server.snapshot())));

  function note(action: string): void { trace.push(action); coverage.add(action.split(" ", 1)[0]!); }

  function client(clientId: string) {
    const emitted: Batch[] = [];
    let changes = 0;
    function create(checkpoint?: ClientCheckpoint<Shape>) {
      const doc = createClient(Board, {
        clientId, ...(checkpoint === undefined ? {} : { checkpoint }),
        onBatch(batch) {
          const owned = decodeClientBatch(Board, json(batch));
          assert.equal(owned.seq, emitted.length + 1);
          for (const operation of owned.operations) {
            if (operation.type !== "list/insert" && operation.type !== "text/insert") continue;
            // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
            const count = operation.type === "list/insert" ? 1 : [...operation.value].length;
            for (let offset = 0; offset < count; offset++) {
              const key = JSON.stringify([operation.path, operation.id.bunchId, operation.id.counter + offset]);
              assert.ok(!insertionIds.has(key), "new local insertion reuses an allocated ID");
              insertionIds.add(key);
            }
          }
          emitted.push(owned);
          trace.push("batch " + JSON.stringify(owned));
        },
      });
      doc.on("change", () => changes++);
      return doc;
    }
    return { clientId, emitted, doc: create(), create, watermark: 0,
      lastBunchSeqs: { items: 0, body: 0 }, get changes() { return changes; } };
  }
  const clients = [client("a"), client("b"), client("c")];
  type Client = typeof clients[number];

  function deliver(target: Client, count = Infinity): boolean {
    const missed = server.commitsSince(target.watermark);
    if (missed === null) { note("history-gap " + target.clientId); return false; }
    for (const commit of missed.slice(0, count)) {
      assert.equal(commit.serverSeq, target.watermark + 1);
      target.doc.receive(decodeServerCommit(Board, json(commit)));
      target.watermark = commit.serverSeq;
      note("deliver " + target.clientId + " " + commit.serverSeq);
    }
    return true;
  }

  function submit(target: Client, nextMode: Mode): boolean {
    if (!deliver(target)) return false;
    const batch = target.doc.checkpoint().pendingBatches[0];
    if (batch === undefined) return false;
    if (nextMode !== "explicit-reject" && target.doc.replayConflict !== null) return false;
    note(nextMode + " " + target.clientId + ":" + batch.seq);
    mode = nextMode;
    if (nextMode !== "explicit-reject") expectedCalls++;
    const input = decodeClientBatch(Board, json(batch));
    const receipt = nextMode === "explicit-reject" ? server.reject(input) : server.receive(input);
    assert.equal(receipt.replayed, false);
    const commit = decodeServerCommit(Board, json(receipt.commit));
    assert.equal(commit.serverSeq, commits.length + 1);
    assert.equal(commit.source.seq, (latest.get(target.clientId)?.batch.seq ?? 0) + 1);
    assert.deepEqual(commit.source, { clientId: target.clientId, seq: batch.seq });
    const operations = nextMode === "explicit-reject" || nextMode === "policy-reject" ? []
      : nextMode === "transform" ? transformed(batch) : batch.operations;
    assert.deepEqual(commit.operations, operations);
    commits.push(commit);
    latest.set(target.clientId, { batch: input, commit });
    snapshots.push(decodeSnapshot(Board, json(server.snapshot())));
    trace.push("commit " + JSON.stringify(commit));
    // The source ack and peer deliveries are deliberately left for later scheduling steps.
    return true;
  }

  function retry(target: Client, entrypoint: "receive" | "reject"): void {
    const previous = latest.get(target.clientId)!;
    const before = server.checkpoint();
    const beforeCalls = calls;
    note("retry-" + entrypoint + " " + target.clientId + ":" + previous.batch.seq);
    const receipt = server[entrypoint](decodeClientBatch(Board, json(previous.batch)));
    assert.equal(receipt.replayed, true);
    assert.deepEqual(receipt.commit, previous.commit);
    assert.deepEqual(server.checkpoint(), before);
    assert.equal(calls, beforeCalls);
    // Never deliver the replay directly: catch-up owns the global ordering and deduplication.
  }

  function fail(target: Client): void {
    if (!deliver(target)) return;
    const batch = target.doc.checkpoint().pendingBatches[0];
    if (batch === undefined || target.doc.replayConflict !== null) return;
    note("resolver-throw " + target.clientId + ":" + batch.seq);
    const before = server.checkpoint();
    mode = "throw";
    expectedCalls++;
    assert.throws(() => server.receive(decodeClientBatch(Board, json(batch))), (error) => error === policyError);
    assert.deepEqual(server.checkpoint(), before);
    assert.equal(submit(target, "accept"), true); // Same sequence, without repairing the original batch.
  }

  function restoreClient(target: Client): void {
    note("restore-client " + target.clientId);
    const checkpoint = target.doc.checkpoint();
    const state = visible(target.doc);
    const conflict = json(target.doc.replayConflict);
    const beforeChanges = target.changes;
    const beforeBatches = target.emitted.length;
    target.doc = target.create(decodeClientCheckpoint(Board, json(checkpoint)));
    assert.deepEqual(target.doc.checkpoint(), checkpoint);
    assert.deepEqual(visible(target.doc), state);
    assert.deepEqual(json(target.doc.replayConflict), conflict);
    assert.equal(target.changes, beforeChanges);
    assert.equal(target.emitted.length, beforeBatches);
  }

  function restoreServer(): void {
    note("restore-server");
    const before = server.checkpoint();
    const beforeCalls = calls;
    server = createServer(Board, { historyLimit, resolve, checkpoint: decodeServerCheckpoint(Board, json(before)) });
    assert.deepEqual(server.checkpoint(), before);
    assert.equal(calls, beforeCalls);
  }

  function check(): void {
    assert.equal(calls, expectedCalls);
    const checkpoint = server.checkpoint();
    assert.equal(checkpoint.snapshot.serverSeq, commits.length);
    assert.deepEqual(checkpoint.snapshot, snapshots.at(-1));
    assert.deepEqual(checkpoint.history, historyLimit === 0 ? [] : commits.slice(-historyLimit));
    assert.equal(checkpoint.replays.length, latest.size);
    for (const replay of checkpoint.replays) assert.deepEqual(replay, latest.get(replay.batch.clientId));
    assert.equal([...latest.values()].reduce((sum, entry) => sum + entry.batch.seq, 0), commits.length);
    let authoritativeCount = 0;
    for (const commit of commits) {
      for (const operation of commit.operations) if (operation.type === "value/set") authoritativeCount = operation.value;
    }
    assert.equal(checkpoint.snapshot.data.count, authoritativeCount);

    for (const target of clients) {
      const saved = target.doc.checkpoint();
      assert.equal(saved.snapshot.serverSeq, target.watermark);
      assert.deepEqual(saved.snapshot, snapshots[target.watermark]);
      assert.equal(saved.lastLocalSeq, target.emitted.length);
      const acknowledged = commits.slice(0, target.watermark).filter((entry) => entry.source.clientId === target.clientId);
      const expectedPending = target.emitted.slice(acknowledged.length);
      assert.deepEqual(saved.pendingBatches, expectedPending);
      for (const path of ["items", "body"] as const) {
        assert.ok(saved.lastBunchSeqs[path] >= target.lastBunchSeqs[path], "allocation counter went backwards");
      }
      target.lastBunchSeqs = { ...saved.lastBunchSeqs };
      const conflict = target.doc.replayConflict;
      const prefixLength = conflict === null ? expectedPending.length
        : expectedPending.findIndex((entry) => entry.seq === conflict.batch.seq);
      if (conflict !== null) {
        coverage.add("blocked");
        assert.ok(prefixLength >= 0);
        assert.deepEqual(conflict.batch, expectedPending[prefixLength]);
        assert.ok(Number.isSafeInteger(conflict.operationIndex) && conflict.operationIndex >= 0
          && conflict.operationIndex < conflict.batch.operations.length);
      }
      let optimisticCount = saved.snapshot.data.count;
      for (const batch of expectedPending.slice(0, prefixLength)) {
        for (const operation of batch.operations) if (operation.type === "value/set") optimisticCount = operation.value;
      }
      assert.equal(target.doc.state.count.value, optimisticCount);
      assert.equal(target.doc.state.items.length, target.doc.state.items.toArray().length);
      assert.deepEqual([...target.doc.state.items], target.doc.state.items.toArray());
      // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
      assert.equal(target.doc.state.body.length, [...target.doc.state.body.toString()].length);
      assert.equal([...target.doc.state.body].join(""), target.doc.state.body.toString());
    }
  }

  function finish(): void {
    // No more local work: each successful round must consume at least one original pending batch.
    const limit = clients.reduce((sum, target) => sum + target.doc.checkpoint().pendingBatches.length, 0);
    for (let round = 0; round <= limit; round++) {
      for (const target of clients) assert.equal(deliver(target), true);
      const remaining = clients.reduce((sum, target) => sum + target.doc.checkpoint().pendingBatches.length, 0);
      if (remaining === 0) break;
      assert.ok(round < limit, "drain exceeded its pending-derived bound");
      const target = clients.find((entry) => entry.doc.checkpoint().pendingBatches.length > 0)!;
      const count = target.doc.checkpoint().pendingBatches.length;
      assert.equal(submit(target, target.doc.replayConflict === null ? "accept" : "explicit-reject"), true);
      assert.equal(deliver(target), true);
      assert.equal(target.doc.checkpoint().pendingBatches.length, count - 1);
      check();
    }
    for (const target of clients) {
      assert.deepEqual(target.doc.checkpoint().pendingBatches, []);
      assert.equal(target.doc.replayConflict, null);
      assert.deepEqual(target.doc.checkpoint().snapshot, server.snapshot());
      assert.deepEqual(visible(target.doc), { count: server.snapshot().data.count,
        items: server.snapshot().data.items.values, body: server.snapshot().data.body.value });
    }
    check();
  }

  return { clients, commits, snapshots, latest, trace, coverage, note, deliver, submit, retry, fail,
    restoreClient, restoreServer, check, finish, get server() { return server; } };
}

function run(seed: number) {
  const h = setup();
  let state = seed >>> 0;
  function pick(length: number): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % length;
  }
  let step = 0;
  let currentAction = "start";
  try {
    for (; step < 200; step++) {
      const actions: { name: string; run: () => void }[] = [];
      for (const target of h.clients) {
        const doc = target.doc;
        if (doc.replayConflict === null) {
          actions.push({ name: "value " + target.clientId, run: () => { doc.state.count.value = pick(100); } });
          actions.push({ name: "list-insert " + target.clientId, run: () => {
            doc.state.items.insert(pick(doc.state.items.length + 1), "item-" + step);
          } });
          if (doc.state.items.length > 0) actions.push({ name: "list-delete " + target.clientId, run: () => {
            doc.state.items.delete(pick(doc.state.items.length));
          } });
          actions.push({ name: "text-insert " + target.clientId, run: () => {
            const words = ["a😀", "e\u0301", "🇹🇼", "x"];
            doc.state.body.insert(pick(doc.state.body.length + 1), words[pick(words.length)]!);
          } });
          if (doc.state.body.length > 0) actions.push({ name: "text-delete " + target.clientId, run: () => {
            const index = pick(doc.state.body.length);
            doc.state.body.delete(index, 1 + pick(doc.state.body.length - index));
          } });
          actions.push({ name: "mixed " + target.clientId, run: () => {
            doc.transact(() => {
              doc.state.count.value = pick(100);
              doc.state.items.insert(pick(doc.state.items.length + 1), "mixed-" + step);
              doc.state.body.insert(pick(doc.state.body.length + 1), "a😀");
            });
            assert.equal(target.emitted.at(-1)!.operations.length, 3);
          } });
          actions.push({ name: "rollback " + target.clientId, run: () => {
            const before = doc.checkpoint();
            const beforeState = visible(doc);
            const beforeChanges = target.changes;
            const failure = new Error("rollback");
            assert.throws(() => doc.transact(() => {
              doc.state.count.value = 99;
              doc.state.items.push("rolled back");
              doc.state.body.insert(0, "😀");
              throw failure;
            }), (error) => error === failure);
            const after = doc.checkpoint();
            assert.deepEqual(visible(doc), beforeState);
            assert.deepEqual({ ...after, lastBunchSeqs: before.lastBunchSeqs }, before);
            assert.equal(target.changes, beforeChanges);
          } });
        }
        const processed = h.latest.get(target.clientId)?.batch.seq ?? 0;
        if (target.emitted.length > processed) {
          for (const mode of ["accept", "policy-reject", "transform", "explicit-reject"] as const) {
            if (doc.replayConflict !== null && mode !== "explicit-reject") continue;
            actions.push({ name: "submit " + mode + " " + target.clientId, run: () => { h.submit(target, mode); } });
          }
          if (doc.replayConflict === null) actions.push({ name: "fail " + target.clientId, run: () => h.fail(target) });
        }
        if (target.watermark < h.commits.length) actions.push({ name: "partial-catch-up " + target.clientId, run: () => {
          assert.equal(h.deliver(target, 1 + pick(h.commits.length - target.watermark)), true);
        } });
        if (h.latest.has(target.clientId)) {
          for (const entrypoint of ["receive", "reject"] as const) actions.push({
            name: "retry " + entrypoint + " " + target.clientId, run: () => h.retry(target, entrypoint),
          });
        }
        actions.push({ name: "restore " + target.clientId, run: () => h.restoreClient(target) });
      }
      actions.push({ name: "restore-server", run: () => h.restoreServer() });
      const action = actions[pick(actions.length)]!;
      currentAction = action.name;
      h.trace.push("step " + step + " " + action.name);
      action.run();
      h.coverage.add(action.name.split(" ", 1)[0]!);
      h.check();
    }
    currentAction = "finish";
    h.finish();
    currentAction = "coverage";
    for (const action of ["value", "list-insert", "list-delete", "text-insert", "text-delete", "mixed",
      "rollback", "accept", "policy-reject", "transform", "explicit-reject", "deliver",
      "partial-catch-up", "retry-receive", "retry-reject", "restore-client", "restore-server", "resolver-throw"]) {
      assert.ok(h.coverage.has(action), "seed did not exercise " + action);
    }
    return { trace: h.trace, commits: h.commits, server: h.server.checkpoint(),
      clients: h.clients.map((entry) => entry.doc.checkpoint()), coverage: [...h.coverage].sort() };
  } catch (cause) {
    const clients = h.clients.map((entry) => ({ clientId: entry.clientId, watermark: entry.watermark,
      pending: entry.doc.checkpoint().pendingBatches.map((batch) => batch.seq) }));
    throw new Error("Interleaving failed: " + JSON.stringify({ seed, step, action: currentAction, clients,
      trace: h.trace }, null, 2), { cause });
  }
}

describe("deterministic multi-client interleaving", () => {
  for (const seed of [1, 7, 42, 2026, 0xdeadbeef]) {
    it("seed=" + seed + " preserves protocol invariants and converges", () => {
      // Compare the complete trace and result, not wall-clock runner output.
      assert.deepEqual(run(seed), run(seed));
    });
  }

  it("restores a blocked mixed suffix across peer commits and cross-entrypoint retries", () => {
    const h = setup();
    const [a, b, c] = h.clients;
    assert.ok(a && b && c);
    a.doc.transact(() => { a.doc.state.count.value = 1; a.doc.state.items.push("A"); a.doc.state.body.insert(0, "😀"); });
    a.doc.transact(() => { a.doc.state.count.value = 2; a.doc.state.items.push("B"); a.doc.state.body.insert(1, "B"); });
    a.doc.state.count.value = 3;
    h.check();
    assert.equal(h.submit(a, "policy-reject"), true); // Lost ack, dependent suffix still optimistic.
    h.retry(a, "receive");
    h.restoreServer();
    h.retry(a, "reject");
    b.doc.transact(() => { b.doc.state.count.value = 4; b.doc.state.items.push("Peer"); b.doc.state.body.insert(0, "p😀"); });
    assert.equal(h.submit(b, "transform"), true);
    assert.equal(h.deliver(a, 1), true);
    assert.equal(a.doc.replayConflict?.batch.seq, 2);
    h.check();
    h.restoreClient(a);
    assert.equal(h.deliver(a), true);
    assert.equal(a.doc.replayConflict?.batch.seq, 2);
    h.check();
    assert.equal(h.submit(a, "explicit-reject"), true);
    h.retry(a, "receive");
    h.restoreServer();
    h.retry(a, "reject");
    assert.equal(h.deliver(a), true);
    assert.equal(a.doc.replayConflict, null);
    assert.deepEqual(a.doc.checkpoint().pendingBatches.map((entry) => entry.seq), [3]);
    a.doc.transact(() => { a.doc.state.items.push("Recovered"); a.doc.state.body.insert(0, "a😀"); });
    h.check();
    h.finish();
    assert.ok(h.coverage.has("blocked"));
    assert.equal(c.doc.state.body.toString(), a.doc.state.body.toString());
  });

  it("retains pending unchanged when a bounded history gap prevents catch-up", () => {
    const h = setup(1);
    const [a, b] = h.clients;
    assert.ok(a && b);
    a.doc.transact(() => { a.doc.state.count.value = 5; a.doc.state.items.push("Pending"); a.doc.state.body.insert(0, "😀"); });
    b.doc.state.count.value = 1;
    assert.equal(h.submit(b, "accept"), true);
    assert.equal(h.deliver(b), true);
    b.doc.state.count.value = 2;
    assert.equal(h.submit(b, "accept"), true);
    const before = a.doc.checkpoint();
    const serverBefore = h.server.checkpoint();
    assert.equal(h.deliver(a), false);
    assert.equal(h.submit(a, "explicit-reject"), false);
    assert.deepEqual(a.doc.checkpoint(), before);
    assert.deepEqual(h.server.checkpoint(), serverBefore);
    h.restoreClient(a);
    h.restoreServer();
    assert.equal(h.deliver(a), false);
    assert.deepEqual(a.doc.checkpoint(), before);
    h.check(); // A history gap is not permission to discard pending or replace the snapshot.
  });
});
