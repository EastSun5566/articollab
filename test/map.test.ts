import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient, createServer, decodeClientBatch, decodeClientCheckpoint, decodeServerCheckpoint, decodeServerCommit,
  decodeSnapshot, defineDocument, list, map, value, WireDecodeError,
  type ClientBatch, type ClientDocument, type DocumentOperation, type ServerCommit,
} from "../src/index.ts";
import { connectSync, createHttpTransport, createSyncHandler } from "../src/sync/index.ts";

const Settings = defineDocument({ fields: map<string | number>(), items: list<string>(), title: value("") });
type Shape = typeof Settings.definition;
type Operation = DocumentOperation<Shape>;
type Batch = ClientBatch<Operation>;
type Commit = ServerCommit<Operation>;
type Doc = ClientDocument<Shape>;

function setup(resolve?: (batch: Batch) => readonly Operation[]) {
  const server = createServer(Settings, resolve === undefined ? {} : { resolve: ({ batch }) => resolve(batch) });
  const client = () => {
    const batches: Batch[] = [];
    const changes: string[] = [];
    const doc = createClient(Settings, { clientId: server.openClient(), onBatch(batch) { batches.push(batch); } });
    doc.on("change", (event) => changes.push(event.origin));
    return { doc, batches, changes };
  };
  const submit = (writer: { batches: Batch[] }): Commit => server.receive(writer.batches.shift()!).commit;
  const deliver = (commit: Commit, ...docs: Doc[]) => { for (const doc of docs) doc.receive(commit); };
  return { server, client, submit, deliver };
}

describe("Map collection", () => {
  it("reads and writes keys in key order, whatever the insertion order", () => {
    const { client } = setup();
    const { doc, batches } = client();
    const fields = doc.state.fields;
    assert.equal(fields.size, 0);
    fields.set("b", 2);
    fields.set("a", 1);
    fields.set("", "empty");
    fields.set("__proto__", "safe");
    fields.set("Z", 0); // "Z" (U+005A) sorts before "a" (U+0061) by code unit.
    assert.equal(fields.size, 5);
    assert.deepEqual([...fields.keys()], ["", "Z", "__proto__", "a", "b"]);
    assert.deepEqual([...fields.values()], ["empty", 0, "safe", 1, 2]);
    assert.deepEqual([...fields], [["", "empty"], ["Z", 0], ["__proto__", "safe"], ["a", 1], ["b", 2]]);
    assert.deepEqual([...fields.entries()], [...fields]);
    assert.equal(fields.get("__proto__"), "safe");
    assert.equal(fields.get("missing"), undefined);
    assert.equal(fields.has("a"), true);
    assert.equal(fields.has("toString"), false, "prototype names are not keys");
    const object = fields.toObject();
    assert.equal(Object.getPrototypeOf(object), Object.prototype);
    assert.ok(Object.hasOwn(object, "__proto__"), "__proto__ is an own key");
    assert.deepEqual(Object.keys(object), ["", "Z", "__proto__", "a", "b"]);
    assert.deepEqual(batches.map(({ operations }) => operations), [
      [{ type: "map/set", path: "fields", key: "b", value: 2 }],
      [{ type: "map/set", path: "fields", key: "a", value: 1 }],
      [{ type: "map/set", path: "fields", key: "", value: "empty" }],
      [{ type: "map/set", path: "fields", key: "__proto__", value: "safe" }],
      [{ type: "map/set", path: "fields", key: "Z", value: 0 }],
    ]);
    assert.ok(Object.isFrozen(batches[0]!.operations[0]));
  });

  it("records a delete even for a key absent here, and reports whether it was present", () => {
    const { client } = setup();
    const { doc, batches } = client();
    doc.state.fields.set("a", 1);
    assert.equal(doc.state.fields.delete("a"), true);
    assert.equal(doc.state.fields.delete("a"), false);
    assert.equal(doc.state.fields.has("a"), false);
    assert.deepEqual(batches.slice(1).map(({ operations }) => operations), [
      [{ type: "map/delete", path: "fields", key: "a" }],
      [{ type: "map/delete", path: "fields", key: "a" }],
    ]);
  });

  it("validates keys and JSON values before any batch", () => {
    const { client } = setup();
    const { doc, batches } = client();
    // @ts-expect-error -- Keys must be strings.
    assert.throws(() => doc.state.fields.set(1, 1), TypeError);
    // @ts-expect-error -- Values must be JSON.
    assert.throws(() => doc.state.fields.set("a", undefined), TypeError);
    assert.throws(() => doc.state.fields.set("a", Number.NaN), TypeError);
    // @ts-expect-error -- Keys must be strings.
    assert.throws(() => doc.state.fields.get(1), TypeError);
    assert.equal(batches.length, 0);
    assert.equal(doc.state.fields.size, 0);
  });

  it("clears every visible key in one batch, and an empty map records nothing", () => {
    const { client } = setup();
    const { doc, batches } = client();
    doc.state.fields.clear();
    assert.equal(batches.length, 0);
    doc.transact(() => { doc.state.fields.set("b", 2); doc.state.fields.set("a", 1); });
    doc.state.fields.clear();
    assert.equal(doc.state.fields.size, 0);
    assert.deepEqual(batches.at(-1)!.operations, [
      { type: "map/delete", path: "fields", key: "a" },
      { type: "map/delete", path: "fields", key: "b" },
    ]);
    doc.state.fields.set("c", 3);
    doc.transact(() => { doc.state.items.push("x"); doc.state.fields.clear(); });
    assert.deepEqual(batches.at(-1)!.operations.map(({ type }) => type), ["list/insert", "map/delete"], "clear joins a transaction");
  });

  it("keeps a key a peer wrote concurrently with a clear", () => {
    const net = setup();
    const a = net.client(), b = net.client();
    a.doc.state.fields.set("old", 1);
    net.deliver(net.submit(a), a.doc, b.doc);
    a.doc.state.fields.clear();
    b.doc.state.fields.set("new", 2);
    net.deliver(net.submit(b), a.doc, b.doc);
    net.deliver(net.submit(a), a.doc, b.doc);
    for (const writer of [a, b]) assert.deepEqual(writer.doc.state.fields.toObject(), { new: 2 });
  });

  it("orders concurrent sets and deletes by server sequence, and a later set recreates a deleted key", () => {
    const net = setup();
    const a = net.client(), b = net.client();
    a.doc.state.fields.set("k", "from A");
    b.doc.state.fields.set("k", "from B");
    net.deliver(net.submit(b), a.doc, b.doc);
    assert.equal(a.doc.state.fields.get("k"), "from A", "pending local work replays over the peer's value");
    net.deliver(net.submit(a), a.doc, b.doc);
    for (const writer of [a, b]) assert.equal(writer.doc.state.fields.get("k"), "from A");

    a.doc.state.fields.delete("k");
    b.doc.state.fields.set("k", "back");
    net.deliver(net.submit(a), a.doc, b.doc);
    net.deliver(net.submit(b), a.doc, b.doc);
    for (const writer of [a, b]) assert.equal(writer.doc.state.fields.get("k"), "back", "the later set wins");

    b.doc.state.fields.set("k", "lost");
    a.doc.state.fields.delete("k");
    net.deliver(net.submit(b), a.doc, b.doc);
    net.deliver(net.submit(a), a.doc, b.doc);
    for (const writer of [a, b]) assert.equal(writer.doc.state.fields.has("k"), false, "the later delete wins");
    assert.deepEqual(net.server.snapshot().data.fields, {});
  });

  it("emits a server change event for a peer's set and delete, but not for an unchanged key", () => {
    const net = setup();
    const a = net.client(), b = net.client();
    b.doc.state.fields.set("k", "v");
    net.deliver(net.submit(b), a.doc, b.doc);
    assert.deepEqual(a.changes, ["server"]);
    b.doc.state.fields.delete("k");
    net.deliver(net.submit(b), a.doc, b.doc);
    assert.deepEqual(a.changes, ["server", "server"], "a remote delete is a visible change");
    b.doc.state.fields.delete("k");
    net.deliver(net.submit(b), a.doc, b.doc);
    assert.deepEqual(a.changes, ["server", "server"], "deleting an absent key changes nothing visible");
  });

  it("never blocks replay: a delete of a key the server never had is a no-op", () => {
    const net = setup();
    const a = net.client();
    a.doc.state.fields.delete("never");
    net.deliver(net.submit(a), a.doc);
    assert.equal(a.doc.replayConflict, null);
    assert.deepEqual(net.server.snapshot().data.fields, {});
  });

  it("rolls back a failed transaction and throws while replay is blocked", () => {
    const net = setup();
    const a = net.client(), b = net.client();
    a.doc.state.fields.set("keep", 1);
    assert.throws(() => a.doc.transact(() => { a.doc.state.fields.set("drop", 2); a.doc.state.fields.delete("keep"); throw new Error("x"); }));
    assert.deepEqual(a.doc.state.fields.toObject(), { keep: 1 });
    assert.equal(a.batches.length, 1);

    // Block A: the server rejects an insertion that A's next pending edit depends on.
    net.deliver(net.submit(a), a.doc, b.doc);
    a.doc.state.items.push("x");
    a.doc.state.items.set(0, "y");
    const insert = a.batches.shift()!;
    net.deliver(net.server.reject(insert).commit, a.doc);
    assert.notEqual(a.doc.replayConflict, null);
    assert.throws(() => a.doc.state.fields.set("k", 1), /blocked/);
    assert.throws(() => a.doc.state.fields.delete("keep"), /blocked/);
    assert.throws(() => a.doc.state.fields.clear(), /blocked/);
    assert.equal(a.batches.length, 1, "only the blocked set is still queued");
  });

  it("adopts transformed acknowledgements and stays silent on exact ones", () => {
    const net = setup((batch) => batch.operations.map((operation) =>
      operation.type === "map/set" && operation.key === "upper" && typeof operation.value === "string"
        ? { ...operation, value: operation.value.toUpperCase() } : operation));
    const a = net.client();
    a.doc.state.fields.set("plain", "x");
    net.deliver(net.submit(a), a.doc);
    assert.deepEqual(a.changes, ["local"], "an exact acknowledgement emits no change event");
    a.doc.state.fields.set("upper", "abc");
    net.deliver(net.submit(a), a.doc);
    assert.equal(a.doc.state.fields.get("upper"), "ABC");
    assert.deepEqual(a.changes, ["local", "local", "server"]);
  });

  it("saves and restores snapshots and checkpoints, with no bunch counters for Map paths", () => {
    const net = setup();
    const a = net.client();
    a.doc.transact(() => { a.doc.state.fields.set("__proto__", 1); a.doc.state.fields.set("a", "x"); });
    net.deliver(net.submit(a), a.doc);
    a.doc.state.fields.set("pending", 2);
    const checkpoint = a.doc.checkpoint();
    assert.deepEqual(Object.keys(checkpoint.lastBunchSeqs), ["items"]);
    assert.ok(Object.hasOwn(checkpoint.snapshot.data.fields, "__proto__"));
    assert.ok(Object.isFrozen(checkpoint.snapshot.data.fields));
    const decoded = decodeClientCheckpoint(Settings, JSON.parse(JSON.stringify(checkpoint)));
    const restored = createClient(Settings, { clientId: checkpoint.clientId, checkpoint: decoded, onBatch() {} });
    assert.deepEqual(restored.state.fields.toObject(), a.doc.state.fields.toObject());
    assert.equal(restored.state.fields.get("__proto__"), 1);
    const typedRestore = createClient(Settings, { clientId: checkpoint.clientId, checkpoint, onBatch() {} });
    assert.equal(typedRestore.state.fields.get("pending"), 2);

    const serverCheckpoint = net.server.checkpoint();
    const server = createServer(Settings, { checkpoint: decodeServerCheckpoint(Settings, JSON.parse(JSON.stringify(serverCheckpoint))) });
    assert.deepEqual(server.snapshot().data.fields, Object.fromEntries([["__proto__", 1], ["a", "x"]]));
    assert.ok(Object.hasOwn(server.snapshot().data.fields, "__proto__"));
    const fresh = createClient(Settings, { clientId: server.openClient(), snapshot: decodeSnapshot(Settings, JSON.parse(JSON.stringify(server.snapshot()))), onBatch() {} });
    assert.deepEqual([...fresh.state.fields.keys()], ["__proto__", "a"]);
  });

  it("decodes Map operations and snapshots strictly", () => {
    const batch = (operation: unknown) => ({ clientId: "client-1", seq: 1, operations: [operation] });
    assert.deepEqual(decodeClientBatch(Settings, batch({ type: "map/set", path: "fields", key: "__proto__", value: { x: 1 } })).operations,
      [{ type: "map/set", path: "fields", key: "__proto__", value: { x: 1 } }]);
    assert.deepEqual(decodeClientBatch(Settings, batch({ type: "map/delete", path: "fields", key: "" })).operations,
      [{ type: "map/delete", path: "fields", key: "" }]);
    for (const operation of [
      { type: "map/set", path: "fields", key: "a" },
      { type: "map/set", path: "fields", key: "a", value: 1, extra: true },
      { type: "map/set", path: "fields", key: 1, value: 1 },
      { type: "map/delete", path: "fields", key: "a", value: 1 },
      { type: "map/set", path: "items", key: "a", value: 1 },
      { type: "list/delete", path: "fields", id: { bunchId: "b", counter: 0 } },
      { type: "value/set", path: "fields", value: {} },
    ]) assert.throws(() => decodeClientBatch(Settings, batch(operation)), WireDecodeError, JSON.stringify(operation));
    assert.throws(() => decodeServerCommit(Settings, { serverSeq: 1, source: { clientId: "client-1", seq: 1 },
      operations: [{ type: "map/set", path: "fields", key: "a", value: Number.POSITIVE_INFINITY }] }), WireDecodeError);
    const snapshot = (fields: unknown) => ({ serverSeq: 0, data: { fields, items: { idList: [], values: [] }, title: "" } });
    assert.deepEqual(decodeSnapshot(Settings, snapshot({ b: 1, a: [2] })).data.fields, { a: [2], b: 1 });
    for (const fields of [[], null, "x", { a: undefined }, { a: () => 1 }]) {
      assert.throws(() => decodeSnapshot(Settings, snapshot(fields)), WireDecodeError, JSON.stringify(fields));
    }
  });

  it("applies Map operations on the server and rejects them on other paths", () => {
    const server = createServer(Settings);
    const clientId = server.openClient();
    server.receive({ clientId, seq: 1, operations: [
      { type: "map/set", path: "fields", key: "a", value: 1 },
      { type: "map/set", path: "fields", key: "b", value: 2 },
      { type: "map/delete", path: "fields", key: "a" },
    ] });
    assert.deepEqual(server.snapshot().data.fields, { b: 2 });
    assert.throws(() => server.receive({ clientId, seq: 2, operations: [
      // @ts-expect-error -- A Map operation on a List path.
      { type: "map/set", path: "items", key: "a", value: 1 },
    ] }));
    assert.deepEqual(server.listClients()[0]!.lastSeq, 1);
  });

  it("synchronizes Map edits through the sync handler and client", async () => {
    const server = createServer(Settings);
    const handle = createSyncHandler(Settings, server);
    const transport = () => createHttpTransport({ url: "http://local/sync/",
      fetch: async (input, init) => handle(new Request(input, init)) });
    const a = await connectSync(Settings, { transport: transport(), pollInterval: 0, push: false });
    const b = await connectSync(Settings, { transport: transport(), pollInterval: 0, push: false });
    try {
      a.doc.state.fields.set("__proto__", "a");
      b.doc.state.fields.set("x", 1);
      b.doc.state.fields.delete("__proto__");
      assert.equal(await a.sync(), true);
      assert.equal(await b.sync(), true);
      assert.equal(await a.sync(), true);
      const expected = Object.fromEntries([["x", 1]]);
      assert.deepEqual(a.doc.state.fields.toObject(), expected, "B's later delete wins");
      assert.deepEqual(b.doc.state.fields.toObject(), expected);
      assert.deepEqual(server.snapshot().data.fields, expected);
    } finally {
      a.close(); b.close();
    }
  });
});
