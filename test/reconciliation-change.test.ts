import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient, createServer, decodeClientBatch, decodeClientCheckpoint, decodeServerCommit,
  defineDocument, list, text, value,
  type ClientDocument, type DocumentOperation, type SavedIdRange,
  type ServerCommit,
} from "../src/index.ts";
import { initialStates, replayPending } from "../src/state.ts";
import { ListState } from "../src/list.ts";
import { TextState } from "../src/text.ts";

const Board = defineDocument({ count: value(0), items: list<{ label: string } | number | null>(), body: text() });
type Shape = typeof Board.definition;
type Doc = ClientDocument<Shape>;
type Commit = ServerCommit<DocumentOperation<Shape>>;
type Mode = "accept" | "reject" | "transform";

function json(input: unknown): unknown { return JSON.parse(JSON.stringify(input)); }

function visibleIds(ranges: readonly SavedIdRange[]): string[] {
  const ids: string[] = [];
  for (const range of ranges) {
    if (range.isDeleted) continue;
    for (let offset = 0; offset < range.count; offset++) {
      ids.push(JSON.stringify([range.bunchId, range.startCounter + offset]));
    }
  }
  return ids;
}

// Rebuild the replayable prefix, then compare every visible ID/reference independently
// of runtime visibleEquals or any future operation-derived shortcut.
function view(doc: Doc) {
  const checkpoint = doc.checkpoint();
  const { states } = replayPending(initialStates(Board, checkpoint.snapshot), checkpoint.pendingBatches);
  const items = states.get("items"), body = states.get("body"), count = states.get("count");
  assert.ok(items instanceof ListState && body instanceof TextState && typeof count === "number");
  const listSnapshot = items.save(), textSnapshot = body.save();
  const visible = doc.state.items.toArray();
  assert.equal(visible.length, listSnapshot.values.length);
  for (const [index, payload] of visible.entries()) assert.ok(Object.is(payload, listSnapshot.values[index]));
  assert.equal(doc.state.body.toString(), textSnapshot.value);
  assert.ok(Object.is(doc.state.count.value, count));
  return { count, items: listSnapshot.values, itemIds: visibleIds(listSnapshot.idList),
    body: textSnapshot.value, textIds: visibleIds(textSnapshot.idList), conflict: doc.replayConflict };
}

function changed(before: ReturnType<typeof view>, after: ReturnType<typeof view>): boolean {
  const sameIds = (left: string[], right: string[]) => left.length === right.length &&
    left.every((id, index) => id === right[index]);
  const left = before.conflict, right = after.conflict;
  const sameConflict = left === null || right === null ? left === right :
    left.batch === right.batch && left.operationIndex === right.operationIndex && left.message === right.message;
  return !sameConflict || !Object.is(before.count, after.count) ||
    !sameIds(before.itemIds, after.itemIds) || before.items.length !== after.items.length ||
    before.items.some((payload, index) => !Object.is(payload, after.items[index])) ||
    !sameIds(before.textIds, after.textIds) || before.body !== after.body;
}

function setup() {
  let mode: Mode = "accept";
  const server = createServer(Board, { resolve: ({ batch }) => {
    if (mode === "reject") return [];
    if (mode === "accept") return batch.operations;
    return batch.operations.map((operation) => {
      if (operation.type === "list/insert" && typeof operation.value === "object" && operation.value !== null) {
        return { ...operation, value: { label: "server:" + operation.value.label } };
      }
      if (operation.type === "value/set") return { ...operation, value: -operation.value };
      if (operation.type === "text/insert") return { ...operation, value: operation.value.toUpperCase() };
      return operation;
    });
  } });
  const coverage = new Set<string>();
  function client() {
    const clientId = server.openClient();
    let changes = 0;
    let doc = createClient(Board, { clientId, onBatch() {} });
    const subscribe = () => doc.on("change", (event) => { if (event.origin === "server") changes++; });
    subscribe();
    return { clientId, get doc() { return doc; }, get changes() { return changes; }, restore() {
      const before = decodeClientCheckpoint(Board, json(doc.checkpoint())), count = changes;
      doc = createClient(Board, { clientId, checkpoint: before, onBatch() {} });
      subscribe();
      assert.deepEqual(doc.checkpoint(), before);
      assert.equal(changes, count);
      coverage.add("restore");
    } };
  }
  const clients = [client(), client()];
  type Client = typeof clients[number];
  function receive(target: Client, commit: Commit, decoded = true): void {
    const before = view(target.doc), count = target.changes;
    target.doc.receive(decoded ? decodeServerCommit(Board, json(commit)) : commit);
    const after = view(target.doc);
    const expected = changed(before, after);
    assert.equal(target.changes - count, Number(expected),
      `full visible comparison differs at ${target.clientId}, serverSeq=${commit.serverSeq}`);
    assert.equal(target.doc.checkpoint().snapshot.serverSeq, commit.serverSeq);
    coverage.add(expected ? "changed" : "silent");
    coverage.add(commit.source.clientId === target.clientId ? "own" : "remote");
    coverage.add(decoded ? "decoded" : "in-memory");
    if (after.conflict !== null) coverage.add("blocked");
  }
  function catchUp(target: Client): void {
    const missed = server.commitsSince(target.doc.checkpoint().snapshot.serverSeq);
    assert.notEqual(missed, null);
    for (const commit of missed!) receive(target, commit, commit.serverSeq % 2 === 0);
  }
  function submit(target: Client, decision: Mode | "explicit-reject", decoded = true): Commit | undefined {
    catchUp(target);
    const pending = target.doc.checkpoint().pendingBatches[0];
    if (pending === undefined) return undefined;
    const input = decoded ? decodeClientBatch(Board, json(pending)) : pending;
    const reject = decision === "explicit-reject" || target.doc.replayConflict !== null;
    mode = decision === "explicit-reject" ? "accept" : decision;
    coverage.add(reject ? "explicit-reject" : decision);
    return (reject ? server.reject(input) : server.receive(input)).commit;
  }
  return { server, clients, coverage, receive, catchUp, submit };
}

function random(seed: number) {
  let state = seed >>> 0;
  return (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
}

describe("full visible change comparison", () => {
  it("matches full comparison for idle remote replacement and cancelled ID edits", () => {
    const network = setup();
    const [writer, peer] = network.clients;
    assert.ok(writer !== undefined && peer !== undefined);
    const deliver = (decision: Mode | "explicit-reject") => {
      const commit = network.submit(writer, decision)!;
      network.receive(writer, commit);
      network.receive(peer, commit);
      assert.deepEqual(peer.doc.checkpoint().pendingBatches, []);
      assert.equal(peer.doc.replayConflict, null);
    };
    writer.doc.transact(() => {
      writer.doc.state.items.push({ label: "A" });
      writer.doc.state.items.push({ label: "B" });
    });
    deliver("accept");
    peer.restore();
    writer.doc.transact(() => {
      writer.doc.state.items.delete(1);
      writer.doc.state.items.insert(1, { label: "B" });
    });
    deliver("accept");
    writer.doc.transact(() => {
      writer.doc.state.items.insert(0, { label: "temporary anchor" });
      writer.doc.state.items.insert(1, { label: "survives its anchor" });
      writer.doc.state.items.delete(0);
      writer.doc.state.items.delete(2);
    });
    deliver("transform");
    const changes = peer.changes;
    writer.doc.transact(() => {
      writer.doc.state.items.push({ label: "temporary" });
      writer.doc.state.items.delete(2);
    });
    deliver("accept");
    writer.doc.state.items.push({ label: "rejected" });
    deliver("explicit-reject");
    assert.equal(peer.changes, changes);
    assert.deepEqual(peer.doc.checkpoint().snapshot, network.server.snapshot());
  });

  it("distinguishes cancellation, object identity, signed zero and dependent rejection", () => {
    const network = setup();
    const [writer, peer] = network.clients;
    assert.ok(writer !== undefined && peer !== undefined);
    writer.doc.transact(() => {
      writer.doc.state.items.push({ label: "temporary" }); writer.doc.state.items.delete(0);
      writer.doc.state.body.insert(0, "😀"); writer.doc.state.body.delete(0);
    });
    const cancelled = network.submit(writer, "accept", false)!;
    network.receive(writer, cancelled, false); network.receive(peer, cancelled, true);
    assert.equal(writer.changes, 0); assert.equal(peer.changes, 0);

    writer.doc.state.items.push({ label: "A" });
    const accepted = network.submit(writer, "accept", false)!;
    network.receive(writer, accepted, true); network.receive(peer, accepted, true);
    assert.equal(writer.changes, 1);
    writer.doc.state.items.push({ label: "hidden by pending delete" });
    writer.doc.state.items.delete(1);
    const beforeHiddenAck = writer.changes;
    const hidden = network.submit(writer, "accept", false)!;
    network.receive(writer, hidden, true); network.receive(peer, hidden, true);
    assert.equal(writer.changes, beforeHiddenAck);
    const removed = network.submit(writer, "accept", false)!;
    network.receive(writer, removed, true); network.receive(peer, removed, true);
    assert.equal(writer.changes, beforeHiddenAck);
    writer.doc.state.items.push(0);
    const zero = network.submit(writer, "accept", false)!;
    network.receive(writer, zero, false); network.receive(peer, zero, false);
    writer.doc.transact(() => { writer.doc.state.items.delete(1); writer.doc.state.items.insert(1, -0); });
    const replacement = network.submit(writer, "accept", false)!;
    network.receive(writer, replacement, false); network.receive(peer, replacement, false);
    assert.ok(Object.is(peer.doc.state.items.get(1), -0));

    writer.doc.transact(() => { writer.doc.state.items.push({ label: "anchor" }); writer.doc.state.body.insert(0, "A"); });
    writer.doc.transact(() => {
      writer.doc.state.count.value = 9; writer.doc.state.items.push({ label: "dependent" });
      writer.doc.state.body.insert(1, "b");
    });
    const rejected = network.submit(writer, "reject")!;
    network.receive(writer, rejected); network.receive(peer, rejected);
    assert.notEqual(writer.doc.replayConflict, null);
    writer.restore();
    assert.ok(Object.is(writer.doc.state.items.get(1), 0)); // JSON does not preserve signed zero.
    peer.doc.state.count.value = 7;
    const remote = network.submit(peer, "accept")!;
    network.receive(writer, remote); network.receive(peer, remote);
    const cleared = network.submit(writer, "explicit-reject")!;
    network.receive(writer, cleared); network.receive(peer, cleared);
    assert.equal(writer.doc.replayConflict, null);
    assert.deepEqual(writer.doc.checkpoint().pendingBatches, []);
    assert.ok(network.coverage.has("blocked") && network.coverage.has("silent"));
  });

  for (const seed of [1, 42, 2026]) it(`matches full comparison across interleavings seed=${seed}`, () => {
    const network = setup(), choose = random(seed), trace: string[] = [];
    let step = 0, submissions = 0;
    try {
      for (; step < 120; step++) {
        const target = network.clients[choose(network.clients.length)]!;
        const action = step % 9;
        trace.push(`${step}:${target.clientId}:${action}`);
        if (action <= 4 && target.doc.replayConflict === null) {
          const size = target.doc.state.items.length;
          const index = choose(Math.max(size, 1));
          if (action === 0 || size === 0) target.doc.state.items.insert(choose(size + 1), { label: String(step) });
          else if (action === 1) target.doc.transact(() => {
            target.doc.state.items.delete(index); target.doc.state.items.insert(index, { label: String(step) });
          });
          else if (action === 2) target.doc.state.items.delete(index);
          else if (action === 3) target.doc.transact(() => {
            target.doc.state.items.push({ label: "cancel" }); target.doc.state.items.delete(size);
          });
          else target.doc.transact(() => {
            target.doc.state.count.value = step;
            target.doc.state.items.push({ label: String(step) });
            target.doc.state.body.insert(target.doc.state.body.length, "a😀");
          });
        } else if (action === 5 || action === 8) {
          const decision = (["accept", "reject", "transform", "explicit-reject"] as const)[submissions++ % 4]!;
          network.submit(target, decision, step % 2 === 0);
        } else if (action === 6) network.catchUp(target);
        else if (action === 7) target.restore();
      }
      for (const target of network.clients) network.catchUp(target);
      const remaining = network.clients.reduce((sum, target) => sum + target.doc.checkpoint().pendingBatches.length, 0);
      for (let round = 0; round < remaining; round++) {
        const target = network.clients.find((entry) => entry.doc.checkpoint().pendingBatches.length > 0)!;
        const before = target.doc.checkpoint().pendingBatches.length;
        const commit = network.submit(target, "accept")!;
        for (const recipient of network.clients) network.catchUp(recipient);
        assert.equal(target.doc.checkpoint().pendingBatches.length, before - 1);
        assert.equal(commit.serverSeq, network.server.snapshot().serverSeq);
      }
      for (const target of network.clients) {
        assert.deepEqual(target.doc.checkpoint().pendingBatches, []);
        assert.equal(target.doc.replayConflict, null);
        assert.deepEqual(target.doc.checkpoint().snapshot, network.server.snapshot());
      }
      for (const action of ["accept", "reject", "transform", "explicit-reject", "restore",
        "own", "remote", "decoded", "in-memory", "changed", "silent"]) {
        assert.ok(network.coverage.has(action), `seed did not cover ${action}`);
      }
    } catch (cause) {
      throw new Error(`seed=${seed}, step=${step}, trace=${trace.join(" ")}`, { cause });
    }
  });
});
