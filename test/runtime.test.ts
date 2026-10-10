import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IdList } from "articulated";

import { ListState } from "../src/list.ts";
import { TextState } from "../src/text.ts";

import {
  createClient,
  createServer,
  decodeClientBatch,
  decodeClientCheckpoint,
  decodeServerCommit,
  defineDocument,
  list,
  text,
  value as valueSchema,
  type ChangeEvent,
  type ClientBatch,
  type DocumentOperation,
  type DocumentSnapshot,
  type JsonValue,
  type ServerCheckpoint,
  type ServerDocument,
  type ServerCommit,
  type ServerResolveContext,
} from "../src/index.ts";

const Counter = defineDocument({
  count: valueSchema(0),
});

const Items = defineDocument({
  items: list<string>(),
});

type CounterOperation = DocumentOperation<typeof Counter.definition>;
type CounterCommit = ServerCommit<CounterOperation>;

function setup() {
  const batches: ClientBatch<CounterOperation>[] = [];
  const doc = createClient(Counter, {
    clientId: "client-1",
    onBatch: (batch) => batches.push(batch),
  });
  return { batches, doc };
}

// oxlint-disable-next-line eslint/no-constant-condition -- Compile-only negative type assertions must never execute.
if (false) {
  const { doc } = setup();
  // @ts-expect-error Transactions must not continue after an await.
  // oxlint-disable-next-line typescript/no-floating-promises -- Compile-only @ts-expect-error verifies async transactions are rejected; this block never executes.
  doc.transact(async () => {});

  createServer(Counter, {
    // @ts-expect-error Server resolvers must return operations synchronously.
    resolve: async ({ batch }) => batch.operations,
  });
}

describe("client runtime", () => {
  it("rejects invalid schema defaults and local Value payloads without side effects", () => {
    let getterReads = 0;
    const getter = () => { getterReads++; return 1; };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const invalids: unknown[] = [
      undefined, NaN, Infinity, -Infinity, 1n, () => {}, Symbol("value"),
      new Date(), new Map(), new Set(), /pattern/, cycle,
      { nested: undefined }, { nested: [Infinity] }, new Array<unknown>(1),
      { [Symbol("key")]: 1 }, Object.assign([0], { extra: 1 }),
      Object.defineProperty({}, "hidden", { value: 1 }),
      Object.defineProperty({}, "bad/~", { get: getter, enumerable: true }),
      Object.defineProperty([0], "0", { get: getter, enumerable: true }),
      { toJSON: () => { getterReads++; return 1; } },
    ];
    const schema = defineDocument({ data: valueSchema<JsonValue>(null) });
    let batches = 0;
    let changes = 0;
    const doc = createClient(schema, { clientId: "local", onBatch: () => batches++ });
    doc.on("change", () => changes++);
    const before = doc.checkpoint();
    for (const input of invalids) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately bypass static JSON typing to verify local runtime rejection.
      const payload = input as JsonValue;
      assert.throws(() => valueSchema(payload), TypeError);
      const manual = defineDocument({ data: { kind: "value", initialValue: payload } });
      assert.throws(() => createClient(manual, { clientId: "manual", onBatch() {} }), TypeError);
      assert.throws(() => createServer(manual), TypeError);
      assert.throws(() => { doc.state.data.value = payload; }, TypeError);
      assert.throws(() => doc.state.data.set(payload), TypeError);
      assert.strictEqual(doc.state.data.value, null);
      assert.deepEqual(doc.checkpoint(), before);
    }
    assert.equal(getterReads, 0);
    assert.equal(batches, 0);
    assert.equal(changes, 0);
    doc.state.data.set(1);
    assert.equal(doc.checkpoint().lastLocalSeq, 1);
    assert.equal(batches, 1);
    assert.equal(changes, 1);

    const defaultPayload: Record<string, JsonValue> = { nested: 1 };
    const defaults = defineDocument({ data: valueSchema(defaultPayload) });
    defaultPayload.nested = NaN; // Violates immutability; construction must still recheck defaults.
    assert.throws(() => createClient(defaults, { clientId: "defaults", onBatch() {} }), TypeError);
    assert.throws(() => createServer(defaults), TypeError);
  });

  it("preserves valid local JSON references, descriptors and signed zero", () => {
    const dictionary: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>; // oxlint-disable-line typescript/no-unsafe-type-assertion -- This fixture creates a null-prototype JSON dictionary.
    dictionary.label = "valid";
    const shared = { nested: [1, null, false, "", 0, -0, 1.5] };
    const payload = { dictionary, left: shared, right: shared, ["__proto__"]: { safe: true } };
    const schema = defineDocument({ data: valueSchema<JsonValue>(payload) });
    const doc = createClient(schema, { clientId: "refs", onBatch() {} });
    const server = createServer(schema);
    assert.strictEqual(doc.state.data.value, payload);
    assert.strictEqual(server.snapshot().data.data, payload);
    doc.state.data.set(payload);
    const operation = doc.checkpoint().pendingBatches[0]!.operations[0]!;
    assert.strictEqual(operation.value, payload);
    assert.strictEqual(payload.left, payload.right);
    assert.equal(Object.getPrototypeOf(dictionary), null);
    assert.ok(Object.hasOwn(payload, "__proto__"));
    for (const object of [payload, dictionary, shared, shared.nested, payload.__proto__]) {
      assert.equal(Object.isFrozen(object), false);
    }
    for (const primitive of [null, false, "", 0, -0, 1.5]) {
      doc.state.data.set(primitive);
      assert.ok(Object.is(doc.state.data.value, primitive));
    }
  });

  it("validates 20,000 levels without recursion and reports deep invalid payload positions", () => {
    const depth = 20_000;
    const payload: JsonValue = JSON.parse('{"a/~":'.repeat(depth) + '0' + '}'.repeat(depth)) as JsonValue; // oxlint-disable-line typescript/no-unsafe-type-assertion -- The fixture is generated entirely from valid JSON tokens.
    const schema = defineDocument({ data: valueSchema<JsonValue>(payload) });
    const doc = createClient(schema, { clientId: "client-1", onBatch() {} });
    assert.strictEqual(doc.state.data.value, payload);
    doc.state.data.set(payload);
    assert.strictEqual(doc.state.data.value, payload);
    let node = payload;
    for (let index = 0; index < depth; index++) {
      assert.ok(typeof node === "object" && node !== null && !Array.isArray(node));
      assert.equal(Object.isFrozen(node), false);
      node = node["a/~"]!;
    }
    assert.equal(node, 0);

    const cycle: Record<string, unknown> = {};
    let invalid: unknown = Infinity;
    let cyclic: unknown = cycle;
    for (let index = 0; index < depth; index++) {
      invalid = { "a/~": invalid };
      cyclic = { "a/~": cyclic };
    }
    cycle.back = cyclic;
    const before = doc.checkpoint();
    for (const [input, suffix] of [[invalid, ""], [cyclic, "/back"]] as const) {
      assert.throws(() => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Negative deep fixtures intentionally violate the static JSON constraint.
        doc.state.data.set(input as JsonValue);
      }, (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.ok(error.message.includes("/data" + "/a~1~0".repeat(depth) + suffix));
        return true;
      });
    }
    // Avoid recursive deep assertions on the valid 20,000-level retained payload.
    assert.equal(doc.checkpoint().lastLocalSeq, before.lastLocalSeq);
    assert.strictEqual(doc.checkpoint().pendingBatches[0], before.pendingBatches[0]);
    assert.strictEqual(doc.state.data.value, payload);
  });

  it("rolls back a mixed transaction when JSON validation escapes the callback", () => {
    const schema = defineDocument({ count: valueSchema(0), items: list<JsonValue>(), body: text() });
    let batches = 0;
    let changes = 0;
    const doc = createClient(schema, { clientId: "rollback", onBatch: () => batches++ });
    doc.on("change", () => changes++);
    assert.throws(() => doc.transact(() => {
      doc.state.count.set(1);
      doc.state.items.push("valid");
      doc.state.body.insert(0, "😀");
      doc.state.count.set(NaN);
    }), TypeError);
    assert.equal(doc.state.count.value, 0);
    assert.deepEqual(doc.state.items.toArray(), []);
    assert.equal(doc.state.body.toString(), "");
    assert.deepEqual(doc.checkpoint().pendingBatches, []);
    assert.equal(doc.checkpoint().lastLocalSeq, 0);
    assert.equal(batches, 0);
    assert.equal(changes, 0);
    doc.state.count.set(2);
    assert.equal(doc.checkpoint().lastLocalSeq, 1);
  });

  it("keeps valid transaction operations when JSON validation failures are caught", () => {
    const schema = defineDocument({ count: valueSchema(0), items: list<JsonValue>(), body: text() });
    let batches = 0;
    let changes = 0;
    const doc = createClient(schema, { clientId: "caught", onBatch: () => batches++ });
    doc.on("change", () => changes++);
    doc.transact(() => {
      doc.state.count.set(1);
      assert.throws(() => doc.state.count.set(Infinity), TypeError);
      assert.throws(() => doc.state.items.insert(0, NaN), TypeError);
      doc.state.items.push({ label: "valid" });
      doc.state.body.insert(0, "😀");
      doc.state.count.set(2);
    });
    assert.deepEqual(doc.checkpoint().pendingBatches[0]!.operations.map((operation) => operation.type),
      ["value/set", "list/insert", "text/insert", "value/set"]);
    assert.equal(doc.state.count.value, 2);
    assert.deepEqual(doc.state.items.toArray(), [{ label: "valid" }]);
    assert.equal(doc.state.body.toString(), "😀");
    assert.equal(doc.checkpoint().lastLocalSeq, 1);
    assert.deepEqual(doc.checkpoint().lastBunchSeqs, { items: 1, body: 1 });
    assert.equal(batches, 1);
    assert.equal(changes, 1);
  });

  it("skips unchanged collection iteration while retaining equal own acks and real changes", (t) => {
    const Board = defineDocument({ count: valueSchema(0), items: list<string>(), body: text() });
    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const outgoing: ClientBatch<DocumentOperation<typeof Board.definition>>[] = [];
    const remote: ClientBatch<DocumentOperation<typeof Board.definition>>[] = [];
    const doc = createClient(Board, { clientId: "client-1", onBatch: (batch) => outgoing.push(batch) });
    const peer = createClient(Board, { clientId: "client-2", onBatch: (batch) => remote.push(batch) });
    let changes = 0;
    doc.on("change", () => changes++);
    doc.transact(() => {
      doc.state.items.push("a");
      doc.state.body.insert(0, "A😀");
    });
    const first = server.receive(outgoing[0]!).commit;
    const iteration = t.mock.method(IdList.prototype, "values");
    doc.receive(first);
    peer.receive(first);
    assert.equal(changes, 1); // An unchanged own ack retains the optimistic state.
    assert.equal(iteration.mock.calls.length, 0);
    iteration.mock.resetCalls();

    peer.state.count.value = 1;
    const count = server.receive(remote[0]!).commit;
    doc.receive(count);
    peer.receive(count);
    assert.equal(iteration.mock.calls.length, 0);
    assert.equal(changes, 2);
    assert.equal(doc.state.count.value, 1);

    peer.transact(() => {
      peer.state.items.push("b");
      peer.state.body.insert(0, "B");
    });
    const mixed = server.receive(remote[1]!).commit;
    doc.receive(mixed);
    peer.receive(mixed);
    assert.equal(changes, 3);
    assert.deepEqual(doc.state.items.toArray(), ["a", "b"]);
    assert.equal(doc.state.body.toString(), "BA😀");
    assert.equal(doc.checkpoint().pendingBatches.length, 0);
    assert.equal(peer.checkpoint().pendingBatches.length, 0);
  });

  it("confirms decoded mixed own acks after restore without replaying dependent pending", (t) => {
    const Board = defineDocument({ count: valueSchema(0), items: list<string>(), body: text() });
    const server = createServer(Board);
    const clientId = server.openClient();
    const batches: ClientBatch<DocumentOperation<typeof Board.definition>>[] = [];
    const original = createClient(Board, { clientId, onBatch: (batch) => batches.push(batch) });
    original.transact(() => {
      original.state.count.value = 1;
      original.state.items.push("A");
      original.state.body.insert(0, "AB😀");
    });
    original.transact(() => {
      original.state.count.value = 2;
      original.state.items.push("B");
      original.state.body.insert(3, "B");
    });
    original.transact(() => {
      original.state.items.delete(0);
      original.state.body.delete(1, 2);
    });
    const checkpoint = decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(original.checkpoint())));
    const doc = createClient(Board, { clientId, checkpoint, onBatch: (batch) => batches.push(batch) });
    const commits = batches.map((batch) => {
      const { commit } = server.receive(decodeClientBatch(Board, JSON.parse(JSON.stringify(batch))));
      return { commit: decodeServerCommit(Board, JSON.parse(JSON.stringify(commit))), snapshot: server.snapshot() };
    });
    let changes = 0;
    doc.on("change", () => changes++);
    const iteration = t.mock.method(IdList.prototype, "values");
    const listInsert = t.mock.method(ListState.prototype, "insert");
    const listDelete = t.mock.method(ListState.prototype, "delete");
    const textInsert = t.mock.method(TextState.prototype, "insert");
    const textDelete = t.mock.method(TextState.prototype, "delete");
    for (const [index, { commit, snapshot }] of commits.entries()) {
      iteration.mock.resetCalls();
      for (const method of [listInsert, listDelete, textInsert, textDelete]) method.mock.resetCalls();
      doc.receive(commit);
      assert.equal(iteration.mock.calls.length, 0);
      for (const [type, method] of [["list/insert", listInsert], ["list/delete", listDelete],
        ["text/insert", textInsert], ["text/delete", textDelete]] as const) {
        assert.equal(method.mock.calls.length, commit.operations.filter((operation) => operation.type === type).length);
      }
      const saved = doc.checkpoint();
      assert.deepEqual(saved.snapshot, snapshot);
      assert.deepEqual(saved.pendingBatches, checkpoint.pendingBatches.slice(index + 1));
      assert.deepEqual(saved.lastBunchSeqs, checkpoint.lastBunchSeqs);
      assert.equal(saved.lastLocalSeq, 3);
      assert.equal(doc.replayConflict, null);
      assert.equal(changes, 0);
      assert.equal(doc.state.count.value, 2);
      assert.deepEqual(doc.state.items.toArray(), ["B"]);
      assert.equal(doc.state.body.toString(), "AB");
    }
    doc.transact(() => { doc.state.items.push("C"); doc.state.body.insert(2, "😀"); });
    assert.equal(batches[3]!.seq, 4);
    doc.receive(server.receive(batches[3]!).commit);
    assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
    assert.equal(doc.checkpoint().pendingBatches.length, 0);
  });

  it("keeps disjoint pending collections but replays when a later batch overlaps", (t) => {
    const Board = defineDocument({ count: valueSchema(0), items: list<string>(), body: text() });
    const server = createServer(Board);
    const clientId = server.openClient(), peerId = server.openClient();
    const batches: ClientBatch<DocumentOperation<typeof Board.definition>>[] = [];
    const doc = createClient(Board, { clientId, onBatch: (batch) => batches.push(batch) });
    doc.transact(() => { doc.state.items.push("A"); doc.state.body.insert(0, "😀"); });
    doc.transact(() => { doc.state.items.push("B"); doc.state.body.insert(1, "B"); });
    const before = doc.checkpoint();
    let serverChanges = 0;
    doc.on("change", (event) => { if (event.origin === "server") serverChanges++; });
    const first = server.receive({ clientId: peerId, seq: 1,
      operations: [{ type: "value/set", path: "count", value: 9 }] }).commit;
    const iteration = t.mock.method(IdList.prototype, "values");
    const listInsert = t.mock.method(ListState.prototype, "insert");
    const textInsert = t.mock.method(TextState.prototype, "insert");
    doc.receive(first);
    assert.equal(iteration.mock.calls.length, 0);
    assert.equal(listInsert.mock.calls.length, 0);
    assert.equal(textInsert.mock.calls.length, 0);
    const saved = doc.checkpoint();
    assert.deepEqual(saved.pendingBatches, before.pendingBatches);
    assert.deepEqual(saved.lastBunchSeqs, before.lastBunchSeqs);
    assert.deepEqual(saved.snapshot, server.snapshot());
    assert.equal(serverChanges, 1);
    assert.equal(doc.state.count.value, 9);
    assert.deepEqual(doc.state.items.toArray(), ["A", "B"]);
    assert.equal(doc.state.body.toString(), "😀B");

    doc.state.count.value = 4;
    const overlap = server.receive({ clientId: peerId, seq: 2,
      operations: [{ type: "value/set", path: "count", value: 10 }] }).commit;
    listInsert.mock.resetCalls(); textInsert.mock.resetCalls();
    doc.receive(overlap);
    assert.equal(listInsert.mock.calls.length, 2);
    assert.equal(textInsert.mock.calls.length, 2);
    assert.equal(doc.state.count.value, 4);
    assert.equal(serverChanges, 1);
    assert.deepEqual(doc.checkpoint().pendingBatches, batches);
  });

  it("retains Object.is payload semantics for accepted, decoded and transformed own acks", () => {
    const Board = defineDocument({ data: valueSchema<{ label: string } | null>(null), items: list<{ label: string }>() });
    for (const kind of ["value", "list"] as const) for (const mode of ["original", "decoded", "transformed"] as const) {
      const server = createServer(Board, mode === "transformed" ? { resolve: ({ batch }) =>
        batch.operations.map((operation) => operation.type === "value/set" || operation.type === "list/insert"
          ? { ...operation, value: { label: "A" } } : operation) } : {});
      const clientId = server.openClient();
      const batches: ClientBatch<DocumentOperation<typeof Board.definition>>[] = [];
      const doc = createClient(Board, { clientId, onBatch: (batch) => batches.push(batch) });
      const payload = { label: "A" };
      if (kind === "value") doc.state.data.value = payload;
      else doc.state.items.push(payload);
      let changes = 0;
      doc.on("change", () => changes++);
      const received = server.receive(batches[0]!).commit;
      const commit = mode === "decoded" ? decodeServerCommit(Board, JSON.parse(JSON.stringify(received))) : received;
      doc.receive(commit);
      const operation = commit.operations[0]!;
      assert.ok(operation.type === "value/set" || operation.type === "list/insert");
      const visible = kind === "value" ? doc.state.data.value : doc.state.items.get(0);
      assert.strictEqual(visible, operation.value);
      assert.equal(Object.is(visible, payload), mode === "original");
      assert.equal(changes, mode === "original" ? 0 : 1);
      assert.equal(doc.checkpoint().pendingBatches.length, 0);
    }
    const { doc } = setup();
    doc.state.count.value = 0;
    let changes = 0;
    doc.on("change", () => changes++);
    doc.receive({ serverSeq: 1, source: { clientId: "client-1", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: -0 }] });
    assert.ok(Object.is(doc.state.count.value, -0));
    assert.equal(changes, 1);
  });

  it("reconciles rejected, reordered, transformed and remapped mixed own operations", () => {
    const Board = defineDocument({ count: valueSchema(0), items: list<string>(), body: text() });
    for (const mode of ["reject", "reorder", "transform", "list-remap", "text-remap"] as const) {
      const batches: ClientBatch<DocumentOperation<typeof Board.definition>>[] = [];
      const doc = createClient(Board, { clientId: "client-1", onBatch: (batch) => batches.push(batch) });
      doc.transact(() => {
        doc.state.count.value = 1; doc.state.items.push("A");
        doc.state.body.insert(0, "😀"); doc.state.count.value = 2;
      });
      const batch = batches[0]!;
      const operations = mode === "reject" ? [] : mode === "reorder" ? batch.operations.toReversed() :
        batch.operations.map((operation) => {
          if ((mode === "list-remap" && operation.type === "list/insert") ||
            (mode === "text-remap" && operation.type === "text/insert")) {
            return { ...operation, id: { bunchId: `server-${operation.path}`, counter: 0 } };
          }
          if (mode === "transform") {
            switch (operation.type) {
              case "value/set": return { ...operation, value: 3 };
              case "list/insert": return { ...operation, value: "B" };
              case "text/insert": return { ...operation, value: "X" };
            }
          }
          return operation;
        });
      let changes = 0;
      doc.on("change", () => changes++);
      doc.receive({ serverSeq: 1, source: batch, operations });
      assert.equal(changes, 1); // Remapped visible IDs change even when rendered values do not.
      assert.equal(doc.state.count.value, mode === "reject" ? 0 : mode === "reorder" ? 1 : mode === "transform" ? 3 : 2);
      assert.deepEqual(doc.state.items.toArray(), mode === "reject" ? [] : [mode === "transform" ? "B" : "A"]);
      assert.equal(doc.state.body.toString(), mode === "reject" ? "" : mode === "transform" ? "X" : "😀");
      assert.equal(doc.checkpoint().pendingBatches.length, 0);
    }
  });

  it("does not confuse transformed anchors, deletion targets or ranges with original operations", (t) => {
    const Board = defineDocument({ items: list<string>(), body: text() });
    const a = { bunchId: "seed", counter: 0 }, b = { bunchId: "seed", counter: 1 };
    for (const mode of ["anchor", "target", "range-count", "range-start", "range-order"] as const) {
      const batches: ClientBatch<DocumentOperation<typeof Board.definition>>[] = [];
      const doc = createClient(Board, { clientId: "client-1", onBatch: (batch) => batches.push(batch) });
      doc.receive({ serverSeq: 1, source: { clientId: "peer", seq: 1 }, operations: [
        { type: "list/insert", path: "items", before: null, id: a, value: "A" },
        { type: "list/insert", path: "items", before: a, id: b, value: "B" },
        { type: "text/insert", path: "body", before: null, id: a, value: "AB" },
        { type: "text/insert", path: "body", before: b, id: { bunchId: "second", counter: 0 }, value: "CD" },
      ] });
      if (mode === "anchor") doc.transact(() => { doc.state.items.insert(1, "X"); doc.state.body.insert(1, "😀"); });
      else if (mode === "target") doc.state.items.delete(0);
      else doc.state.body.delete(1, 2);
      const batch = batches[0]!;
      const operations = batch.operations.map((operation) => {
        if (operation.type === "list/insert" || operation.type === "text/insert") return { ...operation, before: b };
        if (operation.type === "list/delete") return { ...operation, id: b };
        if (operation.type === "text/delete") {
          return { ...operation, ranges: mode === "range-order" ? operation.ranges.toReversed() :
            operation.ranges.map((range, index) => mode === "range-count" && index === 1
              ? { ...range, count: 2 } : mode === "range-start" && index === 0
                ? { ...range, start: a } : range) };
        }
        return operation;
      });
      let changes = 0;
      doc.on("change", () => changes++);
      const iteration = t.mock.method(IdList.prototype, "values");
      doc.receive({ serverSeq: 2, source: batch, operations });
      if (mode === "range-order") assert.ok(iteration.mock.calls.length > 0);
      iteration.mock.restore();
      assert.equal(changes, mode === "range-order" ? 0 : 1);
      assert.deepEqual(doc.state.items.toArray(), mode === "anchor" ? ["A", "B", "X"] : mode === "target" ? ["A"] : ["A", "B"]);
      assert.equal(doc.state.body.toString(), mode === "anchor" ? "AB😀CD" : mode === "range-count" ? "A" :
        mode === "range-start" ? "BD" : mode === "range-order" ? "AD" : "ABCD");
      assert.equal(doc.checkpoint().pendingBatches.length, 0);
    }
  });

  it("validates all authoritative operations before using reconciliation shortcuts", () => {
    const Board = defineDocument({ count: valueSchema(0), items: list<string>(), body: text() });
    const batches: ClientBatch<DocumentOperation<typeof Board.definition>>[] = [];
    const doc = createClient(Board, { clientId: "client-1", onBatch: (batch) => batches.push(batch) });
    doc.transact(() => { doc.state.items.push("A"); doc.state.body.insert(0, "😀"); });
    let changes = 0;
    doc.on("change", () => changes++);
    const before = doc.checkpoint();
    const peer = { clientId: "peer", seq: 1 };
    const invalids: unknown[] = [
      { serverSeq: 2, source: peer, operations: [] },
      { serverSeq: 1, source: { clientId: "client-1", seq: 2 }, operations: batches[0]!.operations },
      { serverSeq: 1, source: peer, operations: [{ type: "list/insert", path: "count", before: null,
        id: { bunchId: "bad", counter: 0 }, value: "bad" }] },
      { serverSeq: 1, source: peer, operations: [{ type: "value/set", path: "missing", value: 1 }] },
      { serverSeq: 1, source: batches[0], operations: [
        { type: "value/set", path: "count", value: 9 },
        { type: "text/insert", path: "body", before: { bunchId: "unknown", counter: 0 },
          id: { bunchId: "bad", counter: 0 }, value: "bad" },
      ] },
    ];
    for (const invalid of invalids) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed commits exercise atomic runtime validation before any shortcut.
      assert.throws(() => doc.receive(invalid as ServerCommit<DocumentOperation<typeof Board.definition>>));
      assert.deepEqual(doc.checkpoint(), before);
      assert.deepEqual(doc.state.items.toArray(), ["A"]);
      assert.equal(doc.state.body.toString(), "😀");
      assert.equal(doc.state.count.value, 0);
      assert.equal(changes, 0);
    }
    doc.receive({ serverSeq: 1, source: batches[0]!, operations: batches[0]!.operations });
    assert.equal(doc.checkpoint().snapshot.serverSeq, 1);
    assert.equal(doc.checkpoint().pendingBatches.length, 0);
    assert.equal(changes, 0);
  });

  it("publishes disjoint reconciliation state before a listener creates another batch", () => {
    const Board = defineDocument({ count: valueSchema(0), items: list<string>(), body: text() });
    const server = createServer(Board);
    const clientId = server.openClient(), peerId = server.openClient();
    const batches: ClientBatch<DocumentOperation<typeof Board.definition>>[] = [];
    const doc = createClient(Board, { clientId, onBatch: (batch) => batches.push(batch) });
    doc.transact(() => { doc.state.items.push("A"); doc.state.body.insert(0, "😀"); });
    let serverChanges = 0;
    doc.on("change", (event) => {
      if (event.origin !== "server") return;
      serverChanges++;
      const saved = doc.checkpoint();
      assert.equal(saved.snapshot.serverSeq, 1);
      assert.deepEqual(saved.pendingBatches, [batches[0]]);
      assert.equal(doc.state.count.value, 2);
      assert.deepEqual(doc.state.items.toArray(), ["A"]);
      assert.equal(doc.state.body.toString(), "😀");
      doc.transact(() => { doc.state.items.push("B"); doc.state.body.insert(1, "B"); });
    });
    doc.receive(server.receive({ clientId: peerId, seq: 1,
      operations: [{ type: "value/set", path: "count", value: 2 }] }).commit);
    assert.deepEqual(batches.map((batch) => batch.seq), [1, 2]);
    for (const batch of batches) doc.receive(server.receive(batch).commit);
    assert.equal(serverChanges, 1);
    assert.equal(doc.checkpoint().pendingBatches.length, 0);
    assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(doc.state.items.toArray(), ["A", "B"]);
    assert.equal(doc.state.body.toString(), "😀B");
  });

  it("infers the schema state and emits one batch for a mutation", () => {
    const { batches, doc } = setup();
    const initialCount: number = doc.state.count.value;
    assert.equal(initialCount, 0);

    const changes: number[] = [];
    doc.on("change", () => changes.push(doc.state.count.value));

    doc.state.count.value = 1;

    assert.equal(doc.state.count.value, 1);
    assert.deepEqual(batches, [
      {
        clientId: "client-1",
        seq: 1,
        operations: [{ type: "value/set", path: "count", value: 1 }],
      },
    ]);
    assert.deepEqual(changes, [1]);
  });

  it("groups transaction operations into one batch and one change", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);

    const result = doc.transact(() => {
      doc.state.count.value = 2;
      doc.state.count.set(3);
      return "result";
    });

    assert.equal(result, "result");
    assert.equal(doc.state.count.value, 3);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]?.operations, [
      { type: "value/set", path: "count", value: 2 },
      { type: "value/set", path: "count", value: 3 },
    ]);
    assert.equal(changes, 1);
  });

  it("joins nested transactions until the outer callback returns", () => {
    const { batches, doc } = setup();
    const changes: ChangeEvent<CounterOperation>[] = [];
    doc.on("change", (event) => changes.push(event));

    const result = doc.transact(() => {
      doc.state.count.value = 1;
      const innerResult = doc.transact(() => {
        doc.state.count.value = 2;
        assert.deepEqual(batches, []);
        assert.deepEqual(changes, []);
        return "inner";
      });
      assert.equal(innerResult, "inner");
      assert.equal(doc.state.count.value, 2);
      assert.deepEqual(batches, []);
      assert.deepEqual(changes, []);
      doc.state.count.value = 3;
      return "outer";
    });

    assert.equal(result, "outer");
    assert.equal(doc.state.count.value, 3);
    assert.deepEqual(batches, [{
      clientId: "client-1",
      seq: 1,
      operations: [
        { type: "value/set", path: "count", value: 1 },
        { type: "value/set", path: "count", value: 2 },
        { type: "value/set", path: "count", value: 3 },
      ],
    }]);
    assert.deepEqual(changes, [{ origin: "local", batch: batches[0] }]);
    assert.deepEqual(doc.checkpoint().pendingBatches, batches);
    assert.equal(doc.checkpoint().lastLocalSeq, 1);
  });

  it("rolls back an escaping nested exception without consuming a sequence", () => {
    const { batches, doc } = setup();
    const changes: ChangeEvent<CounterOperation>[] = [];
    doc.on("change", (event) => changes.push(event));
    const before = doc.checkpoint();
    const failure = new Error("inner callback failed");

    assert.throws(() => doc.transact(() => {
      doc.state.count.value = 1;
      doc.transact(() => {
        doc.state.count.value = 2;
        throw failure;
      });
    }), (error) => error === failure);

    assert.equal(doc.state.count.value, 0);
    assert.deepEqual(doc.checkpoint(), before);
    assert.deepEqual(batches, []);
    assert.deepEqual(changes, []);

    doc.state.count.value = 3;

    assert.equal(doc.state.count.value, 3);
    assert.deepEqual(batches, [{
      clientId: "client-1",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 3 }],
    }]);
    assert.deepEqual(doc.checkpoint().pendingBatches, batches);
    assert.equal(doc.checkpoint().lastLocalSeq, 1);
    assert.deepEqual(changes, [{ origin: "local", batch: batches[0] }]);
  });

  it("keeps inner mutations when the outer callback catches their exception", () => {
    const { batches, doc } = setup();
    const changes: ChangeEvent<CounterOperation>[] = [];
    doc.on("change", (event) => changes.push(event));
    const failure = new Error("caught inner failure");

    doc.transact(() => {
      doc.state.count.value = 1;
      assert.throws(() => doc.transact(() => {
        doc.state.count.value = 2;
        throw failure;
      }), (error) => error === failure);
      assert.equal(doc.state.count.value, 2);
      assert.deepEqual(batches, []);
      assert.deepEqual(changes, []);
      doc.state.count.value = 3;
    });

    assert.equal(doc.state.count.value, 3);
    assert.deepEqual(batches, [{
      clientId: "client-1",
      seq: 1,
      operations: [
        { type: "value/set", path: "count", value: 1 },
        { type: "value/set", path: "count", value: 2 },
        { type: "value/set", path: "count", value: 3 },
      ],
    }]);
    assert.deepEqual(doc.checkpoint().pendingBatches, batches);
    assert.equal(doc.checkpoint().lastLocalSeq, 1);
    assert.deepEqual(changes, [{ origin: "local", batch: batches[0] }]);
  });

  it("keeps a completed transaction pending when onBatch throws", () => {
    const batches: ClientBatch<CounterOperation>[] = [];
    const changes: ChangeEvent<CounterOperation>[] = [];
    const failure = new Error("onBatch failed");
    let failOnBatch = true;
    const doc = createClient(Counter, {
      clientId: "client-1",
      onBatch: (batch) => {
        batches.push(batch);
        const checkpoint = doc.checkpoint();
        assert.equal(doc.state.count.value, batch.seq);
        assert.equal(checkpoint.lastLocalSeq, batch.seq);
        assert.deepEqual(checkpoint.pendingBatches, batches);
        assert.equal(checkpoint.pendingBatches.at(-1), batch);
        assert.equal(changes.length, 0);
        if (failOnBatch) throw failure;
      },
    });
    doc.on("change", (event) => changes.push(event));

    assert.throws(() => doc.transact(() => {
      doc.state.count.value = 1;
    }), (error) => error === failure);

    assert.equal(doc.state.count.value, 1);
    const firstPending = doc.checkpoint();
    assert.equal(firstPending.lastLocalSeq, 1);
    assert.deepEqual(firstPending.pendingBatches, [{
      clientId: "client-1",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 1 }],
    }]);
    assert.deepEqual(changes, []);

    failOnBatch = false;
    doc.state.count.value = 2;

    assert.equal(doc.state.count.value, 2);
    assert.equal(doc.checkpoint().lastLocalSeq, 2);
    assert.deepEqual(batches.map((batch) => batch.seq), [1, 2]);
    assert.deepEqual(doc.checkpoint().pendingBatches, batches);
    assert.equal(doc.checkpoint().pendingBatches[0], firstPending.pendingBatches[0]);
    assert.deepEqual(firstPending.pendingBatches, [batches[0]]);
    assert.deepEqual(batches[1]?.operations, [
      { type: "value/set", path: "count", value: 2 },
    ]);
    assert.deepEqual(changes, [{ origin: "local", batch: batches[1] }]);
  });

  it("keeps the batch and stops later notifications when a local listener throws", () => {
    const batches: ClientBatch<CounterOperation>[] = [];
    const changes: ChangeEvent<CounterOperation>[] = [];
    const trace: string[] = [];
    const failure = new Error("local listener failed");
    const doc = createClient(Counter, {
      clientId: "client-1",
      onBatch: (batch) => {
        batches.push(batch);
        trace.push(`batch:${batch.seq}`);
      },
    });
    const unsubscribe = doc.on("change", (event) => {
      assert.equal(event.origin, "local");
      trace.push("first listener");
      throw failure;
    });
    doc.on("change", (event) => {
      trace.push("second listener");
      changes.push(event);
    });

    assert.throws(() => {
      doc.state.count.value = 1;
    }, (error) => error === failure);

    assert.deepEqual(trace, ["batch:1", "first listener"]);
    assert.deepEqual(changes, []);
    assert.equal(doc.state.count.value, 1);
    assert.equal(doc.checkpoint().lastLocalSeq, 1);
    assert.deepEqual(doc.checkpoint().pendingBatches, [{
      clientId: "client-1",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 1 }],
    }]);

    unsubscribe();
    doc.state.count.value = 2;

    assert.deepEqual(trace, ["batch:1", "first listener", "batch:2", "second listener"]);
    assert.equal(doc.state.count.value, 2);
    assert.equal(doc.checkpoint().lastLocalSeq, 2);
    assert.deepEqual(batches.map((batch) => batch.seq), [1, 2]);
    assert.deepEqual(doc.checkpoint().pendingBatches, batches);
    assert.deepEqual(batches[1]?.operations, [
      { type: "value/set", path: "count", value: 2 },
    ]);
    assert.deepEqual(changes, [{ origin: "local", batch: batches[1] }]);
  });

  it("does nothing for an empty transaction", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);

    doc.transact(() => {});

    assert.deepEqual(batches, []);
    assert.equal(changes, 0);
  });

  it("unsubscribes change listeners", () => {
    const { doc } = setup();
    let changes = 0;
    const unsubscribe = doc.on("change", () => changes++);

    doc.state.count.value = 1;
    unsubscribe();
    doc.state.count.value = 2;

    assert.equal(changes, 1);
  });

  it("sends reentrant listener mutations in batch order", () => {
    const { batches, doc } = setup();
    let mutateAgain = true;
    doc.on("change", (event) => {
      if (event.origin === "local" && mutateAgain) {
        mutateAgain = false;
        doc.state.count.value = 2;
      }
    });

    doc.state.count.value = 1;

    assert.equal(doc.state.count.value, 2);
    assert.deepEqual(
      batches.map((batch) => batch.seq),
      [1, 2]
    );
  });

  it("rolls back a failed transaction without emitting", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);

    assert.throws(() => {
      doc.transact(() => {
        doc.state.count.value = 2;
        throw new Error("stop");
      });
    }, /stop/);

    assert.equal(doc.state.count.value, 0);
    assert.deepEqual(batches, []);
    assert.equal(changes, 0);
  });

  it("rejects server commits during a transaction", () => {
    const { batches, doc } = setup();

    assert.throws(() => {
      doc.transact(() => {
        doc.state.count.value = 1;
        doc.receive({
          serverSeq: 1,
          source: { clientId: "client-2", seq: 1 },
          operations: [{ type: "value/set", path: "count", value: 9 }],
        });
      });
    }, /Cannot receive a server commit during a transaction/);

    assert.equal(doc.state.count.value, 0);
    assert.deepEqual(batches, []);

    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-2", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 9 }],
    });
    assert.equal(doc.state.count.value, 9);
  });

  it("applies a remote server commit", () => {
    const { doc } = setup();
    const changes: ChangeEvent<CounterOperation>[] = [];
    doc.on("change", (event) => changes.push(event));

    const commit: CounterCommit = {
      serverSeq: 1,
      source: { clientId: "client-2", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 4 }],
    };
    doc.receive(commit);

    assert.equal(doc.state.count.value, 4);
    assert.deepEqual(changes, [{ origin: "server", commit }]);
  });

  it("replays pending batches until their own commits arrive", () => {
    const { doc } = setup();
    const serverChanges: number[] = [];
    doc.on("change", (event) => {
      if (event.origin === "server") {
        serverChanges.push(doc.state.count.value);
      }
    });

    doc.state.count.value = 1;
    doc.state.count.value = 2;

    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-2", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 9 }],
    });
    assert.equal(doc.state.count.value, 2);

    doc.receive({
      serverSeq: 2,
      source: { clientId: "client-1", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 1 }],
    });
    doc.receive({
      serverSeq: 3,
      source: { clientId: "client-1", seq: 2 },
      operations: [{ type: "value/set", path: "count", value: 2 }],
    });

    assert.equal(doc.state.count.value, 2);
    assert.deepEqual(serverChanges, []);

    doc.receive({
      serverSeq: 4,
      source: { clientId: "client-2", seq: 2 },
      operations: [{ type: "value/set", path: "count", value: 3 }],
    });

    assert.equal(doc.state.count.value, 3);
    assert.deepEqual(serverChanges, [3]);
  });

  it("rolls back a rejected optimistic batch", () => {
    const { doc } = setup();
    const serverChanges: number[] = [];
    doc.on("change", (event) => {
      if (event.origin === "server") {
        serverChanges.push(doc.state.count.value);
      }
    });

    doc.state.count.value = 1;
    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-1", seq: 1 },
      operations: [],
    });

    assert.equal(doc.state.count.value, 0);
    assert.deepEqual(serverChanges, [0]);
  });

  it("uses a transformed server result for an own batch", () => {
    const { doc } = setup();

    doc.state.count.value = 1;
    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-1", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 5 }],
    });

    assert.equal(doc.state.count.value, 5);
  });

  it("rejects out-of-order commits without changing reconciliation state", () => {
    const { doc } = setup();

    assert.throws(
      () =>
        doc.receive({
          serverSeq: 2,
          source: { clientId: "client-2", seq: 1 },
          operations: [{ type: "value/set", path: "count", value: 2 }],
        }),
      /Expected server sequence 1/
    );
    assert.equal(doc.state.count.value, 0);

    doc.state.count.value = 1;
    assert.throws(
      () =>
        doc.receive({
          serverSeq: 1,
          source: { clientId: "client-1", seq: 2 },
          operations: [],
        }),
      /does not match the next pending batch/
    );
    assert.equal(doc.state.count.value, 1);

    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-1", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 1 }],
    });
    assert.throws(
      () =>
        doc.receive({
          serverSeq: 1,
          source: { clientId: "client-2", seq: 1 },
          operations: [],
        }),
      /Expected server sequence 2/
    );
  });

  it("rejects unknown operation types without advancing server sequence", () => {
    const { doc } = setup();
    const invalidCommit = {
      serverSeq: 1,
      source: { clientId: "client-2", seq: 1 },
      operations: [
        {
          type: "bogus",
          path: "count",
          id: { bunchId: "invalid", counter: 0 },
        },
      ],
    } as unknown as CounterCommit; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.

    assert.throws(() => doc.receive(invalidCommit), /Unknown operation type: bogus/);
    assert.equal(doc.state.count.value, 0);

    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-2", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 1 }],
    });
    assert.equal(doc.state.count.value, 1);
  });

  it("rejects an empty client id", () => {
    assert.throws(
      () => createClient(Counter, { clientId: "", onBatch: () => {} }),
      /clientId must not be empty/
    );
  });
});

describe("server runtime", () => {
  it("orders batches and converges two clients", () => {
    const server = createServer(Counter);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const commits: CounterCommit[] = [];
    const receivers: Array<(commit: CounterCommit) => void> = [];
    const commitQueue: CounterCommit[] = [];
    let broadcasting = false;
    const send = (batch: ClientBatch<CounterOperation>) => {
      const commit = server.receive(batch).commit;
      commits.push(commit);
      commitQueue.push(commit);
      if (broadcasting) return;

      broadcasting = true;
      try {
        while (commitQueue.length > 0) {
          const nextCommit = commitQueue.shift()!;
          for (const receive of receivers) receive(nextCommit);
        }
      } finally {
        broadcasting = false;
      }
    };

    const client1 = createClient(Counter, {
      clientId: "client-1",
      onBatch: send,
    });
    const client2 = createClient(Counter, {
      clientId: "client-2",
      onBatch: send,
    });
    receivers.push(
      (commit) => client1.receive(commit),
      (commit) => client2.receive(commit)
    );

    client1.state.count.value = 1;
    client2.transact(() => {
      client2.state.count.value = 2;
      client2.state.count.value = 3;
    });

    assert.equal(client1.state.count.value, 3);
    assert.equal(client2.state.count.value, 3);
    assert.deepEqual(
      commits.map(({ serverSeq, source }) => ({ serverSeq, source })),
      [
        { serverSeq: 1, source: { clientId: "client-1", seq: 1 } },
        { serverSeq: 2, source: { clientId: "client-2", seq: 1 } },
      ]
    );
  });

  it("finishes broadcasting a commit before a listener creates the next one", () => {
    const server = createServer(Counter);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const receivers: Array<(commit: CounterCommit) => void> = [];
    const commitQueue: CounterCommit[] = [];
    let broadcasting = false;
    const send = (batch: ClientBatch<CounterOperation>) => {
      commitQueue.push(server.receive(batch).commit);
      if (broadcasting) return;

      broadcasting = true;
      try {
        while (commitQueue.length > 0) {
          const commit = commitQueue.shift()!;
          for (const receive of receivers) receive(commit);
        }
      } finally {
        broadcasting = false;
      }
    };

    const client1 = createClient(Counter, {
      clientId: "client-1",
      onBatch: send,
    });
    const client2 = createClient(Counter, {
      clientId: "client-2",
      onBatch: send,
    });
    receivers.push(
      (commit) => client2.receive(commit),
      (commit) => client1.receive(commit)
    );

    let mutateOnce = true;
    client2.on("change", (event) => {
      if (event.origin === "server" && mutateOnce) {
        mutateOnce = false;
        client2.state.count.value = 2;
      }
    });

    client1.state.count.value = 1;

    assert.equal(client1.state.count.value, 2);
    assert.equal(client2.state.count.value, 2);
  });

  it("uses server receive order for concurrent optimistic writes", () => {
    const server = createServer(Counter);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const client1Batches: ClientBatch<CounterOperation>[] = [];
    const client2Batches: ClientBatch<CounterOperation>[] = [];
    const client1 = createClient(Counter, {
      clientId: "client-1",
      onBatch: (batch) => client1Batches.push(batch),
    });
    const client2 = createClient(Counter, {
      clientId: "client-2",
      onBatch: (batch) => client2Batches.push(batch),
    });

    client1.state.count.value = 1;
    client2.state.count.value = 2;

    const client2Commit = server.receive(client2Batches[0]!).commit;
    client1.receive(client2Commit);
    client2.receive(client2Commit);
    assert.equal(client1.state.count.value, 1);
    assert.equal(client2.state.count.value, 2);

    const client1Commit = server.receive(client1Batches[0]!).commit;
    client1.receive(client1Commit);
    client2.receive(client1Commit);

    assert.equal(client1Commit.serverSeq, 2);
    assert.equal(client1.state.count.value, 1);
    assert.equal(client2.state.count.value, 1);
  });

  it("rejects invalid batches without consuming sequence numbers", () => {
    const server = createServer(Counter);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");

    assert.throws(
      () =>
        server.receive({
          clientId: "client-1",
          seq: 2,
          operations: [{ type: "value/set", path: "count", value: 2 }],
        }),
      /Expected client sequence 1/
    );

    const firstCommit = server.receive({
      clientId: "client-1",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 1 }],
    }).commit;
    assert.equal(firstCommit.serverSeq, 1);

    assert.throws(
      () =>
        server.receive({
          clientId: "client-1",
          seq: 1,
          operations: [{ type: "value/set", path: "count", value: 2 }],
        }),
      /Retry batch differs/
    );

    const unknownPathBatch = {
      clientId: "client-2",
      seq: 1,
      operations: [{ type: "value/set", path: "missing", value: 2 }],
    } as unknown as ClientBatch<CounterOperation>; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
    assert.throws(
      () => server.receive(unknownPathBatch),
      /Unknown document path: missing/
    );

    const secondCommit = server.receive({
      clientId: "client-2",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 2 }],
    }).commit;
    assert.equal(secondCommit.serverSeq, 2);
  });

  it("owns an immutable snapshot of accepted operations", () => {
    const server = createServer(Counter);
    assert.equal(server.openClient(), "client-1");
    const operations = [
      { type: "value/set" as const, path: "count" as const, value: 1 },
    ];

    const commit = server.receive({
      clientId: "client-1",
      seq: 1,
      operations,
    }).commit;
    operations[0]!.value = 9;
    operations.push({ type: "value/set", path: "count", value: 10 });

    assert.deepEqual(commit.operations, [
      { type: "value/set", path: "count", value: 1 },
    ]);
    assert.ok(Object.isFrozen(commit.operations));
    assert.ok(Object.isFrozen(commit.operations[0]));
  });
});

describe("server policy", () => {
  it("lazily saves each frozen policy snapshot once from its captured pre-batch state", (t) => {
    const Board = defineDocument({ count: valueSchema(0), items: list<string>(), body: text() });
    const contexts: ServerResolveContext<typeof Board.definition>[] = [];
    const listSave = t.mock.method(ListState.prototype, "save");
    const textSave = t.mock.method(TextState.prototype, "save");
    const server = createServer(Board, {
      resolve: (context) => { contexts.push(context); return context.batch.operations; },
    });
    assert.equal(server.openClient(), "client-1");
    const batches: ClientBatch<DocumentOperation<typeof Board.definition>>[] = [];
    const doc = createClient(Board, { clientId: "client-1", onBatch: (batch) => batches.push(batch) });
    doc.transact(() => {
      doc.state.count.value = 1;
      doc.state.items.push("a");
      doc.state.body.insert(0, "A😀");
    });
    server.receive(batches[0]!);
    doc.state.count.value = 2;
    server.receive(batches[1]!);
    assert.equal(listSave.mock.calls.length, 0);
    assert.equal(textSave.mock.calls.length, 0);

    const first = contexts[0]!;
    assert.ok(Object.isFrozen(first));
    const snapshot = first.snapshot; // First read happens after two successful commits.
    assert.deepEqual(snapshot, {
      serverSeq: 0,
      data: { count: 0, items: { idList: [], values: [] }, body: { idList: [], value: "" } },
    });
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.data));
    assert.strictEqual(first.snapshot, snapshot);
    assert.equal(listSave.mock.calls.length, 1);
    assert.equal(textSave.mock.calls.length, 1);

    const second = contexts[1]!.snapshot;
    assert.equal(second.serverSeq, 1);
    assert.equal(second.data.count, 1);
    assert.deepEqual(second.data.items.values, ["a"]);
    assert.equal(second.data.body.value, "A😀");
    assert.strictEqual(contexts[1]!.snapshot, second);
    assert.equal(listSave.mock.calls.length, 2);
    assert.equal(textSave.mock.calls.length, 2);
  });

  it("resolves from a frozen pre-commit snapshot and owns transformed operations", () => {
    let transformedOperations: Array<{
      type: "value/set";
      path: "count";
      value: number;
    }> = [];
    const server = createServer(Counter, {
      resolve: (context) => {
        assert.ok(Object.isFrozen(context));
        assert.ok(Object.isFrozen(context.batch));
        assert.ok(Object.isFrozen(context.batch.operations));
        assert.ok(Object.isFrozen(context.batch.operations[0]));
        assert.ok(Object.isFrozen(context.snapshot));
        assert.ok(Object.isFrozen(context.snapshot.data));
        assert.deepEqual(context.snapshot, {
          serverSeq: 0,
          data: { count: 0 },
        });

        const currentCount: number = context.snapshot.data.count;
        assert.equal(currentCount, 0);
        transformedOperations = context.batch.operations.map((operation) => ({
          ...operation,
          value: Math.min(operation.value, 5),
        }));
        return transformedOperations;
      },
    });
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const batches: ClientBatch<CounterOperation>[] = [];
    const client1 = createClient(Counter, {
      clientId: "client-1",
      onBatch: (batch) => batches.push(batch),
    });
    const client2 = createClient(Counter, {
      clientId: "client-2",
      onBatch: () => {},
    });

    client1.state.count.value = 9;
    const commit = server.receive(batches[0]!).commit;
    client1.receive(commit);
    client2.receive(commit);

    transformedOperations[0]!.value = 99;
    transformedOperations.push({ type: "value/set", path: "count", value: 10 });

    assert.deepEqual(commit.operations, [
      { type: "value/set", path: "count", value: 5 },
    ]);
    assert.ok(Object.isFrozen(commit.operations));
    assert.ok(Object.isFrozen(commit.operations[0]));
    assert.equal(client1.state.count.value, 5);
    assert.equal(client2.state.count.value, 5);
    assert.deepEqual(server.snapshot(), {
      serverSeq: 1,
      data: { count: 5 },
    });
  });

  it("uses an empty authoritative operation list to reject a batch", () => {
    const server = createServer(Counter, { resolve: () => [] });
    assert.equal(server.openClient(), "client-1");
    const batches: ClientBatch<CounterOperation>[] = [];
    const client = createClient(Counter, {
      clientId: "client-1",
      onBatch: (batch) => batches.push(batch),
    });

    client.state.count.value = 1;
    const commit = server.receive(batches[0]!).commit;
    client.receive(commit);

    assert.deepEqual(commit, {
      serverSeq: 1,
      source: { clientId: "client-1", seq: 1 },
      operations: [],
    });
    assert.equal(client.state.count.value, 0);
    assert.deepEqual(server.snapshot(), {
      serverSeq: 1,
      data: { count: 0 },
    });
  });

  it("keeps resolver failures and reentrant receives atomic", () => {
    type Mode =
      | "throw"
      | "non-array"
      | "invalid-path"
      | "unknown-type"
      | "reentrant"
      | "accept";
    let mode: Mode = "throw";
    let server: ServerDocument<typeof Counter.definition>;
    server = createServer(Counter, {
      // oxlint-disable-next-line typescript/consistent-return -- Exhaustive test-mode switch intentionally injects a non-array undefined result.
      resolve: ({ batch }) => {
        switch (mode) {
          case "throw":
            throw new Error("policy failed");
          case "non-array":
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
            return undefined as unknown as readonly CounterOperation[];
          case "invalid-path":
            return [
              { type: "value/set", path: "missing", value: 9 },
            ] as unknown as readonly CounterOperation[]; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
          case "unknown-type":
            return [
              {
                type: "bogus",
                path: "count",
                id: { bunchId: "invalid", counter: 0 },
              },
            ] as unknown as readonly CounterOperation[]; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
          case "reentrant":
            server.receive({
              clientId: "client-2",
              seq: 1,
              operations: [{ type: "value/set", path: "count", value: 9 }],
            });
            return batch.operations;
          case "accept":
            return batch.operations;
        }
      },
    });
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const batch: ClientBatch<CounterOperation> = {
      clientId: "client-1",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 1 }],
    };

    assert.throws(() => server.receive(batch), /policy failed/);
    assert.deepEqual(server.snapshot(), { serverSeq: 0, data: { count: 0 } });

    mode = "non-array";
    assert.throws(() => server.receive(batch), /must return an array/);
    assert.deepEqual(server.snapshot(), { serverSeq: 0, data: { count: 0 } });

    mode = "invalid-path";
    assert.throws(() => server.receive(batch), /Unknown document path: missing/);
    assert.deepEqual(server.snapshot(), { serverSeq: 0, data: { count: 0 } });

    mode = "unknown-type";
    assert.throws(() => server.receive(batch), /Unknown operation type: bogus/);
    assert.deepEqual(server.snapshot(), { serverSeq: 0, data: { count: 0 } });

    mode = "reentrant";
    assert.throws(() => server.receive(batch), /reentrantly/);
    assert.deepEqual(server.snapshot(), { serverSeq: 0, data: { count: 0 } });

    mode = "accept";
    const firstCommit = server.receive(batch).commit;
    const secondCommit = server.receive({
      clientId: "client-2",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 2 }],
    }).commit;
    assert.equal(firstCommit.serverSeq, 1);
    assert.equal(secondCommit.serverSeq, 2);
    assert.deepEqual(server.snapshot(), { serverSeq: 2, data: { count: 2 } });
  });
});

describe("snapshot hydration", () => {
  it("snapshots fresh server defaults", () => {
    const server = createServer(Counter);

    const snapshot = server.snapshot();

    assert.deepEqual(snapshot, { serverSeq: 0, data: { count: 0 } });
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.data));
  });

  it("hydrates a late client and continues from the snapshot watermark", () => {
    const server = createServer(Counter);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const firstCommit = server.receive({
      clientId: "client-1",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 1 }],
    }).commit;
    const lateBatches: ClientBatch<CounterOperation>[] = [];
    const lateClient = createClient(Counter, {
      clientId: "client-2",
      snapshot: server.snapshot(),
      onBatch: (batch) => lateBatches.push(batch),
    });

    assert.equal(lateClient.state.count.value, 1);
    assert.deepEqual(lateBatches, []);
    assert.throws(() => lateClient.receive(firstCommit), /Expected server sequence 2/);

    const secondCommit = server.receive({
      clientId: "client-1",
      seq: 2,
      operations: [{ type: "value/set", path: "count", value: 2 }],
    }).commit;
    lateClient.receive(secondCommit);

    assert.equal(lateClient.state.count.value, 2);
  });

  it("starts a late client's sequence at one and converges all clients", () => {
    const server = createServer(Counter);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    let firstBatch: ClientBatch<CounterOperation> | undefined;
    const firstClient = createClient(Counter, {
      clientId: "client-1",
      onBatch: (batch) => {
        firstBatch = batch;
      },
    });
    firstClient.state.count.value = 1;
    const firstCommit = server.receive(firstBatch!).commit;
    firstClient.receive(firstCommit);

    let lateBatch: ClientBatch<CounterOperation> | undefined;
    const lateClient = createClient(Counter, {
      clientId: "client-2",
      snapshot: server.snapshot(),
      onBatch: (batch) => {
        lateBatch = batch;
      },
    });
    lateClient.state.count.value = 2;

    assert.equal(lateBatch?.seq, 1);
    const secondCommit = server.receive(lateBatch).commit;
    firstClient.receive(secondCommit);
    lateClient.receive(secondCommit);

    assert.equal(secondCommit.serverSeq, 2);
    assert.equal(firstClient.state.count.value, 2);
    assert.equal(lateClient.state.count.value, 2);
  });

  it("keeps snapshots point-in-time and rejects invalid hydration data", () => {
    const server = createServer(Counter);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const snapshot = server.snapshot();
    server.receive({
      clientId: "client-1",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 1 }],
    });

    assert.deepEqual(snapshot, { serverSeq: 0, data: { count: 0 } });

    const createFrom = (
      invalidSnapshot: DocumentSnapshot<typeof Counter.definition>
    ) =>
      createClient(Counter, {
        clientId: "client-2",
        snapshot: invalidSnapshot,
        onBatch: () => {},
      });

    assert.throws(
      () => createFrom({ serverSeq: -1, data: { count: 0 } }),
      /non-negative safe integer/
    );
    assert.throws(
      () =>
        createFrom({
          serverSeq: 0,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
          data: {} as { readonly count: number },
        }),
      /Missing snapshot path: count/
    );
    assert.throws(
      () =>
        createFrom({
          serverSeq: 0,
          data: { count: 0, extra: true },
        } as unknown as DocumentSnapshot<typeof Counter.definition>), // oxlint-disable-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
      /Unknown snapshot path: extra/
    );
  });
});

describe("server checkpoint", () => {
  const replay = (clientId: string, seq: number, serverSeq: number, value = 0) => {
    const batch: ClientBatch<CounterOperation> = {
      clientId,
      seq,
      operations: [{ type: "value/set", path: "count", value }],
    };
    return {
      batch,
      commit: { serverSeq, source: { clientId, seq }, operations: batch.operations },
    };
  };

  it("checkpoints fresh state and keeps the result point-in-time", () => {
    const server = createServer(Counter);
    const checkpoint = server.checkpoint();

    assert.deepEqual(checkpoint, {
      snapshot: { serverSeq: 0, data: { count: 0 } },
      history: [],
      lastClientNumber: 0, clients: [],
    });
    assert.ok(Object.isFrozen(checkpoint));
    assert.ok(Object.isFrozen(checkpoint.snapshot));
    assert.ok(Object.isFrozen(checkpoint.clients));

    assert.equal(server.openClient(), "client-1");
    server.receive({
      clientId: "client-1",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 1 }],
    });
    assert.deepEqual(checkpoint, {
      snapshot: { serverSeq: 0, data: { count: 0 } },
      history: [],
      lastClientNumber: 0, clients: [],
    });
  });

  it("restores global and per-client sequences with a new resolver", () => {
    const server = createServer(Counter, {
      resolve: ({ batch }) =>
        batch.clientId === "client-2" ? [] : batch.operations,
    });
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    server.receive({
      clientId: "client-1",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 1 }],
    });
    server.receive({
      clientId: "client-2",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 2 }],
    });

    const checkpoint = server.checkpoint();
    assert.deepEqual(checkpoint, {
      snapshot: { serverSeq: 2, data: { count: 1 } },
      history: [
        replay("client-1", 1, 1, 1).commit,
        { serverSeq: 2, source: { clientId: "client-2", seq: 1 }, operations: [] },
      ],
      lastClientNumber: 2, clients: [
        replay("client-1", 1, 1, 1),
        {
          ...replay("client-2", 1, 2, 2),
          commit: {
            serverSeq: 2,
            source: { clientId: "client-2", seq: 1 },
            operations: [],
          },
        },
      ].map((savedReplay) => ({ clientId: savedReplay.batch.clientId, replay: savedReplay })),
    });
    assert.ok(Object.isFrozen(checkpoint.clients[0]!.replay));

    const restored = createServer(Counter, {
      checkpoint,
      resolve: ({ batch }) =>
        batch.operations.map((operation) => ({
          ...operation,
          value: Math.min(operation.value, 5),
        })),
    });
    assert.deepEqual(restored.snapshot(), checkpoint.snapshot);

    assert.throws(
      () =>
        restored.receive({
          clientId: "client-1",
          seq: 1,
          operations: [{ type: "value/set", path: "count", value: 9 }],
        }),
      /Retry batch differs/
    );
    assert.throws(
      () =>
        restored.receive({
          clientId: "client-1",
          seq: 3,
          operations: [{ type: "value/set", path: "count", value: 9 }],
        }),
      /Expected client sequence 2/
    );

    const client1Commit = restored.receive({
      clientId: "client-1",
      seq: 2,
      operations: [{ type: "value/set", path: "count", value: 9 }],
    }).commit;
    const client2Commit = restored.receive({
      clientId: "client-2",
      seq: 2,
      operations: [{ type: "value/set", path: "count", value: 4 }],
    }).commit;
    const newClientCommit = restored.receive({
      clientId: restored.openClient(),
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 3 }],
    }).commit;

    assert.equal(client1Commit.serverSeq, 3);
    assert.deepEqual(client1Commit.operations, [
      { type: "value/set", path: "count", value: 5 },
    ]);
    assert.equal(client2Commit.serverSeq, 4);
    assert.equal(newClientCommit.serverSeq, 5);
    assert.deepEqual(restored.snapshot(), {
      serverSeq: 5,
      data: { count: 3 },
    });
  });

  it("rejects inconsistent restore metadata", () => {
    const restore = (
      checkpoint: ServerCheckpoint<typeof Counter.definition>
    ) => createServer(Counter, { checkpoint });

    assert.throws(
      () =>
        restore({
          snapshot: { serverSeq: 0, data: { count: 0 } },
          history: [],
          lastClientNumber: 0, clients: [{ clientId: "client-1", replay: null }],
        }),
      /client ID must have been allocated/
    );
    assert.throws(
      () =>
        restore({
          snapshot: { serverSeq: 2, data: { count: 0 } },
          history: [],
          lastClientNumber: 4, clients: [
            replay("client-1", 1, 1),
            replay("client-1", 1, 2),
          ].map((savedReplay) => ({ clientId: savedReplay.batch.clientId, replay: savedReplay })),
        }),
      /clientId must not be duplicated/
    );
    assert.throws(
      () =>
        restore({
          snapshot: { serverSeq: 0, data: { count: 0 } },
          history: [],
          lastClientNumber: 4, clients: [replay("client-1", 0, 1)].map((savedReplay) => ({ clientId: savedReplay.batch.clientId, replay: savedReplay })),
        }),
      /safe integer greater than or equal to 1/
    );

    assert.throws(
      () =>
        createServer(Items, {
          checkpoint: {
            snapshot: {
              serverSeq: 1,
              data: {
                items: {
                  idList: [
                    {
                      bunchId: "one",
                      startCounter: 0,
                      count: 2,
                      isDeleted: false,
                    },
                    {
                      bunchId: "one",
                      startCounter: 1,
                      count: 1,
                      isDeleted: true,
                    },
                  ],
                  values: ["a", "b"],
                },
              },
            },
            history: [],
            lastClientNumber: 0, clients: [],
          },
        }),
      /ranges must not overlap/
    );
  });
});
