import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ListState } from "../src/list.ts";
import { TextState } from "../src/text.ts";

import {
  createClient,
  createServer,
  decodeClientBatch,
  decodeClientCheckpoint,
  decodeServerCheckpoint,
  decodeServerCommit,
  decodeSnapshot,
  defineDocument,
  list,
  text,
  value as valueSchema,
  WireDecodeError,
  type ClientBatch,
  type DocumentOperation,
  type DocumentSnapshot,
  type JsonValue,
} from "../src/index.ts";

const Board = defineDocument({
  meta: valueSchema<{
    status: string;
    nested: { enabled: boolean };
    tags: JsonValue[];
  }>({ status: "draft", nested: { enabled: false }, tags: [] }),
  items: list<{ label: string }>(),
  body: text(),
});

type BoardOperation = DocumentOperation<typeof Board.definition>;
type BoardBatch = ClientBatch<BoardOperation>;

function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function setupClient(clientId: string) {
  const batches: BoardBatch[] = [];
  const doc = createClient(Board, {
    clientId,
    onBatch: (batch) => batches.push(batch),
  });
  return { batches, doc };
}

function assertWireError(callback: () => unknown, path: string): void {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof WireDecodeError);
    assert.equal(error.name, "WireDecodeError");
    assert.equal(error.path, path);
    assert.ok(error.message.startsWith(`Invalid wire value at ${path}:`));
    return true;
  });
}

function valueBatch(value: unknown): Record<string, unknown> {
  return {
    clientId: "client-1",
    seq: 1,
    operations: [{ type: "value/set", path: "meta", value }],
  };
}

describe("wire decoding", () => {
  it("decodes List sets with exact fields, owned payloads and precise error paths", () => {
    const input = { clientId: "client-1", seq: 1, operations: [{ type: "list/set", path: "items",
      id: { bunchId: "another-writer", counter: 0 }, value: { label: "new" } }] };
    const batch = decodeClientBatch(Board, input);
    const operation = batch.operations[0]!;
    assert.equal(operation.type, "list/set");
    assert.ok(Object.isFrozen(operation));
    if (operation.type === "list/set") {
      assert.notStrictEqual(operation.id, input.operations[0]!.id);
      assert.notStrictEqual(operation.value, input.operations[0]!.value);
      assert.ok(Object.isFrozen(operation.id) && Object.isFrozen(operation.value));
      input.operations[0]!.value.label = "changed";
      input.operations[0]!.id.counter = 1;
      assert.equal(operation.value.label, "new");
      assert.equal(operation.id.counter, 0);
    }
    const valid = { type: "list/set", path: "items", id: { bunchId: "id", counter: 0 }, value: { label: "new" } };
    const decode = (candidate: unknown) => decodeClientBatch(Board, { clientId: "client-1", seq: 1, operations: [candidate] });
    for (const field of ["id", "value"]) {
      const missing: Record<string, unknown> = { ...valid };
      delete missing[field];
      assertWireError(() => decode(missing), "/operations/0/" + field);
    }
    assertWireError(() => decode({ ...valid, before: null }), "/operations/0/before");
    assertWireError(() => decode({ ...valid, path: "body" }), "/operations/0/path");
    assertWireError(() => decode({ ...valid, path: "missing" }), "/operations/0/path");
    assertWireError(() => decode({ ...valid, id: { bunchId: "id", counter: -1 } }), "/operations/0/id/counter");
    assertWireError(() => decode({ ...valid, value: { label: undefined } }), "/operations/0/value/label");
    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    const before = server.checkpoint();
    assert.throws(() => server.receive(batch)); // Structure is legal, but the target is not known.
    assert.deepEqual(server.checkpoint(), before);
    const rejected = server.reject(batch);
    const copied = decodeServerCommit(Board, jsonRoundTrip(rejected.commit));
    assert.deepEqual(copied.operations, []);
  });

  it("loads collections once per decoding boundary and reuses decoded snapshots", (t) => {
    const server = createServer(Board);
    const clientId = server.openClient();
    const { batches, doc } = setupClient(clientId);
    doc.transact(() => {
      doc.state.items.push({ label: "gone" });
      doc.state.body.insert(0, "A😀");
    });
    doc.receive(server.receive(batches[0]!).commit);
    doc.transact(() => {
      doc.state.items.delete(0);
      doc.state.body.delete(0);
    });
    doc.receive(server.receive(batches[1]!).commit);
    doc.transact(() => {
      doc.state.items.push({ label: "pending" });
      doc.state.body.insert(1, "B");
    });
    const clientInput = jsonRoundTrip(doc.checkpoint());
    const serverInput = jsonRoundTrip(server.checkpoint());
    const listLoad = t.mock.method(ListState, "load");
    const textLoad = t.mock.method(TextState, "load");

    const snapshot = decodeSnapshot(Board, jsonRoundTrip(server.snapshot()));
    createClient(Board, { clientId: "late", snapshot, onBatch() {} });
    createClient(Board, { clientId: "another", snapshot, onBatch() {} });
    assert.equal(listLoad.mock.calls.length, 1);
    assert.equal(textLoad.mock.calls.length, 1);

    listLoad.mock.resetCalls(); textLoad.mock.resetCalls();
    const checkpoint = decodeClientCheckpoint(Board, clientInput);
    assert.equal(listLoad.mock.calls.length, 1);
    assert.equal(textLoad.mock.calls.length, 1);
    const restored = createClient(Board, { clientId, checkpoint, onBatch() {} });
    // Constructors decode again: reuse is within each owned decoding boundary.
    assert.equal(listLoad.mock.calls.length, 2);
    assert.equal(textLoad.mock.calls.length, 2);
    assert.deepEqual(restored.checkpoint(), checkpoint);
    assert.deepEqual(restored.state.items.toArray(), [{ label: "pending" }]);
    assert.equal(restored.state.body.toString(), "😀B");

    listLoad.mock.resetCalls(); textLoad.mock.resetCalls();
    const restoredServer = createServer(Board, {
      checkpoint: decodeServerCheckpoint(Board, serverInput),
    });
    assert.equal(listLoad.mock.calls.length, 2);
    assert.equal(textLoad.mock.calls.length, 2);
    assert.deepEqual(restoredServer.checkpoint(), server.checkpoint());
  });

  it("isolates reused decoded states and still validates mutable or wrong-kind snapshots", () => {
    const input = { serverSeq: 0, data: {
      meta: { status: "draft", nested: { enabled: false }, tags: [] },
      items: { idList: [{ bunchId: "list-seed", startCounter: 0, count: 1, isDeleted: false }],
        values: [{ label: "A" }] },
      body: { idList: [{ bunchId: "text-seed", startCounter: 0, count: 3, isDeleted: false }], value: "A😀B" },
    } };
    const snapshot = decodeSnapshot(Board, input);
    const left = createClient(Board, { clientId: "left", snapshot, onBatch() {} });
    const right = createClient(Board, { clientId: "right", snapshot, onBatch() {} });
    assert.strictEqual(left.state.items.get(0), snapshot.data.items.values[0]);
    left.transact(() => {
      left.state.items.delete(0);
      left.state.body.delete(1);
    });
    right.transact(() => {
      right.state.items.push({ label: "B" });
      right.state.body.insert(3, "🦊");
    });
    assert.deepEqual(left.state.items.toArray(), []);
    assert.equal(left.state.body.toString(), "AB");
    assert.deepEqual(right.state.items.toArray(), [{ label: "A" }, { label: "B" }]);
    assert.equal(right.state.body.toString(), "A😀B🦊");
    assert.deepEqual(snapshot, input);

    const raw = createClient(Board, { clientId: "raw", snapshot: input, onBatch() {} });
    input.data.body.value = "";
    assert.throws(() => createClient(Board, { clientId: "invalid", snapshot: input, onBatch() {} }));
    assert.equal(raw.state.body.toString(), "A😀B");
    assert.equal(snapshot.data.body.value, "A😀B");

    const otherSchema = defineDocument({ meta: Board.definition.meta, items: text(), body: text() });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Intentionally hydrate the decoded List payload as Text to verify cache kind checks.
    const wrongKind = snapshot as unknown as DocumentSnapshot<typeof otherSchema.definition>;
    assert.throws(() => createClient(otherSchema, { clientId: "wrong-kind", snapshot: wrongKind, onBatch() {} }));
  });

  it("round-trips Value, List, and Text batches and commits", () => {
    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const client1 = setupClient("client-1");
    const client2 = setupClient("client-2");

    client1.doc.transact(() => {
      client1.doc.state.meta.value = {
        status: "ready",
        nested: { enabled: true },
        tags: ["wire"],
      };
      client1.doc.state.items.push({ label: "decode" });
      client1.doc.state.body.insert(0, "Hi 😀");
    });

    const batch = decodeClientBatch(
      Board,
      jsonRoundTrip(client1.batches[0]!)
    );
    assert.ok(Object.isFrozen(batch));
    assert.ok(Object.isFrozen(batch.operations));

    const valueOperation = batch.operations[0];
    assert.equal(valueOperation?.type, "value/set");
    if (valueOperation?.type === "value/set") {
      assert.ok(Object.isFrozen(valueOperation.value));
      assert.ok(Object.isFrozen(valueOperation.value.nested));
    }
    const listOperation = batch.operations[1];
    assert.equal(listOperation?.type, "list/insert");
    if (listOperation?.type === "list/insert") {
      assert.ok(Object.isFrozen(listOperation.value));
      assert.ok(Object.isFrozen(listOperation.id));
    }

    const commit = decodeServerCommit(
      Board,
      jsonRoundTrip(server.receive(batch).commit)
    );
    assert.ok(Object.isFrozen(commit));
    assert.ok(Object.isFrozen(commit.source));
    assert.ok(Object.isFrozen(commit.operations));
    client1.doc.receive(commit);
    client2.doc.receive(commit);

    for (const client of [client1.doc, client2.doc]) {
      assert.deepEqual(client.state.meta.value, {
        status: "ready",
        nested: { enabled: true },
        tags: ["wire"],
      });
      assert.deepEqual(client.state.items.toArray(), [{ label: "decode" }]);
      assert.equal(client.state.body.toString(), "Hi 😀");
    }
  });

  it("round-trips snapshots with List and Text tombstones for late join", () => {
    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    assert.equal(server.openClient(), "client-3");
    const client1 = setupClient("client-1");
    const client2 = setupClient("client-2");

    client1.doc.transact(() => {
      client1.doc.state.items.push({ label: "gone" });
      client1.doc.state.body.insert(0, "A");
    });
    const baseCommit = decodeServerCommit(
      Board,
      jsonRoundTrip(
        server.receive(
          decodeClientBatch(Board, jsonRoundTrip(client1.batches[0]!))
        ).commit
      )
    );
    client1.doc.receive(baseCommit);
    client2.doc.receive(baseCommit);

    client1.doc.state.body.insert(1, "B");
    client2.doc.transact(() => {
      client2.doc.state.items.delete(0);
      client2.doc.state.body.delete(0);
    });
    const deleteCommit = decodeServerCommit(
      Board,
      jsonRoundTrip(
        server.receive(
          decodeClientBatch(Board, jsonRoundTrip(client2.batches[0]!))
        ).commit
      )
    );
    client1.doc.receive(deleteCommit);
    client2.doc.receive(deleteCommit);

    const snapshot = decodeSnapshot(Board, jsonRoundTrip(server.snapshot()));
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.data));
    assert.ok(Object.isFrozen(snapshot.data.items));
    assert.ok(Object.isFrozen(snapshot.data.items.idList));
    assert.ok(snapshot.data.items.idList.some((range) => range.isDeleted));
    assert.ok(snapshot.data.body.idList.some((range) => range.isDeleted));

    const lateClient = createClient(Board, {
      clientId: "client-3",
      snapshot,
      onBatch: () => {},
    });
    assert.deepEqual(lateClient.state.items.toArray(), []);
    assert.equal(lateClient.state.body.toString(), "");

    const insertCommit = decodeServerCommit(
      Board,
      jsonRoundTrip(
        server.receive(
          decodeClientBatch(Board, jsonRoundTrip(client1.batches[1]!))
        ).commit
      )
    );
    client1.doc.receive(insertCommit);
    client2.doc.receive(insertCommit);
    lateClient.receive(insertCommit);
    assert.equal(client1.doc.state.body.toString(), "B");
    assert.equal(client2.doc.state.body.toString(), "B");
    assert.equal(lateClient.state.body.toString(), "B");
  });

  it("round-trips server checkpoints and restores tombstone anchors", () => {
    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const client1 = setupClient("client-1");
    const client2 = setupClient("client-2");

    client1.doc.transact(() => {
      client1.doc.state.items.push({ label: "gone" });
      client1.doc.state.body.insert(0, "A");
    });
    const baseCommit = server.receive(client1.batches[0]!).commit;
    client1.doc.receive(baseCommit);
    client2.doc.receive(baseCommit);

    client1.doc.state.body.insert(1, "B");
    client2.doc.transact(() => {
      client2.doc.state.items.delete(0);
      client2.doc.state.body.delete(0);
    });
    const deleteCommit = server.receive(client2.batches[0]!).commit;
    client1.doc.receive(deleteCommit);
    client2.doc.receive(deleteCommit);

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Known JSON fixture is made mutable to verify ownership or inject corruption; production decoders are tested separately.
    const input = jsonRoundTrip(server.checkpoint()) as {
      snapshot: {
        data: {
          meta: { nested: { enabled: boolean } };
        };
      };
      clients: Array<{ replay: { batch: { clientId: string } } }>;
    };
    const checkpoint = decodeServerCheckpoint(Board, input);
    assert.ok(Object.isFrozen(checkpoint));
    assert.ok(Object.isFrozen(checkpoint.snapshot));
    assert.ok(Object.isFrozen(checkpoint.clients));
    assert.ok(Object.isFrozen(checkpoint.clients[0]!.replay));
    assert.ok(Object.isFrozen(checkpoint.clients[0]!.replay!.batch));
    assert.ok(Object.isFrozen(checkpoint.clients[0]!.replay!.commit));
    assert.ok(Object.isFrozen(checkpoint.snapshot.data.meta.nested));
    assert.ok(
      checkpoint.snapshot.data.items.idList.some((range) => range.isDeleted)
    );
    assert.ok(
      checkpoint.snapshot.data.body.idList.some((range) => range.isDeleted)
    );

    input.snapshot.data.meta.nested.enabled = true;
    input.clients[0]!.replay.batch.clientId = "changed";
    assert.equal(checkpoint.snapshot.data.meta.nested.enabled, false);
    assert.equal(checkpoint.clients[0]?.replay?.batch.clientId, "client-1");

    const restored = createServer(Board, { checkpoint });
    const insertCommit = restored.receive(
      decodeClientBatch(Board, jsonRoundTrip(client1.batches[1]!))
    ).commit;
    assert.equal(insertCommit.serverSeq, 3);
    assert.equal(restored.snapshot().data.body.value, "B");
    assert.deepEqual(restored.snapshot().data.items.values, []);
  });

  it("rejects missing, extra, sparse, unknown, and wrong-kind fields", () => {
    assertWireError(
      () => decodeClientBatch(Board, { seq: 1, operations: [] }),
      "/clientId"
    );
    assertWireError(
      () =>
        decodeClientBatch(Board, {
          clientId: "client-1",
          seq: 1,
          operations: [],
          extra: true,
        }),
      "/extra"
    );
    assertWireError(
      () =>
        decodeClientBatch(Board, {
          clientId: "client-1",
          seq: 1,
          operations: {},
        }),
      "/operations"
    );

    const sparseOperations = new Array<unknown>(1);
    assertWireError(
      () =>
        decodeClientBatch(Board, {
          clientId: "client-1",
          seq: 1,
          operations: sparseOperations,
        }),
      "/operations"
    );
    assertWireError(
      () =>
        decodeClientBatch(Board, {
          clientId: "client-1",
          seq: 1,
          operations: [{ type: "bogus", path: "meta" }],
        }),
      "/operations/0/type"
    );
    assertWireError(
      () =>
        decodeClientBatch(Board, {
          clientId: "client-1",
          seq: 1,
          operations: [
            {
              type: "text/insert",
              path: "items",
              before: null,
              id: { bunchId: "one", counter: 0 },
              value: "x",
            },
          ],
        }),
      "/operations/0/path"
    );
    assertWireError(
      () =>
        decodeClientBatch(Board, {
          clientId: "client-1",
          seq: 1,
          operations: [
            {
              type: "list/delete",
              path: "items",
              id: { bunchId: "one", counter: 0 },
              extra: true,
            },
          ],
        }),
      "/operations/0/extra"
    );
  });

  it("validates sequences, ElementIds, Text ranges, and saved ranges", () => {
    assertWireError(
      () => decodeClientBatch(Board, { clientId: "", seq: 1, operations: [] }),
      "/clientId"
    );
    assertWireError(
      () =>
        decodeClientBatch(Board, {
          clientId: "client-1",
          seq: 0,
          operations: [],
        }),
      "/seq"
    );
    assertWireError(
      () =>
        decodeClientBatch(Board, {
          clientId: "client-1",
          seq: 1,
          operations: [
            {
              type: "text/insert",
              path: "body",
              before: null,
              id: { bunchId: "", counter: 0 },
              value: "x",
            },
          ],
        }),
      "/operations/0/id/bunchId"
    );
    assertWireError(
      () =>
        decodeClientBatch(Board, {
          clientId: "client-1",
          seq: 1,
          operations: [
            {
              type: "text/delete",
              path: "body",
              ranges: [],
            },
          ],
        }),
      "/operations/0/ranges"
    );
    assertWireError(
      () =>
        decodeClientBatch(Board, {
          clientId: "client-1",
          seq: 1,
          operations: [
            {
              type: "text/delete",
              path: "body",
              ranges: [
                { start: { bunchId: "one", counter: 0 }, count: 0 },
              ],
            },
          ],
        }),
      "/operations/0/ranges/0/count"
    );
    assertWireError(
      () =>
        decodeClientBatch(Board, {
          clientId: "client-1",
          seq: 1,
          operations: [
            {
              type: "text/delete",
              path: "body",
              ranges: [
                {
                  start: { bunchId: "one", counter: Number.MAX_SAFE_INTEGER },
                  count: 2,
                },
              ],
            },
          ],
        }),
      "/operations/0/ranges/0/count"
    );
    assertWireError(
      () =>
        decodeServerCommit(Board, {
          serverSeq: 0,
          source: { clientId: "server", seq: 1 },
          operations: [],
        }),
      "/serverSeq"
    );
    assertWireError(
      () =>
        decodeSnapshot(Board, {
          serverSeq: 0,
          data: {
            meta: { status: "draft", nested: { enabled: false }, tags: [] },
            items: {
              idList: [
                {
                  bunchId: "one",
                  startCounter: 0,
                  count: 1,
                  isDeleted: "no",
                },
              ],
              values: [{ label: "x" }],
            },
            body: { idList: [], value: "" },
          },
        }),
      "/data/items/idList/0/isDeleted"
    );
  });

  it("deep-copies and freezes JSON values while rejecting non-JSON input", () => {
    const nested = {
      status: "ready",
      nested: { enabled: true },
      tags: ["a", { deep: 1 }],
    };
    const input = valueBatch(nested);
    const decoded = decodeClientBatch(Board, input);
    const operation = decoded.operations[0];
    assert.equal(operation?.type, "value/set");
    if (operation?.type !== "value/set") return;

    nested.status = "changed";
    nested.nested.enabled = false;
    nested.tags[0] = "changed";
    assert.deepEqual(operation.value, {
      status: "ready",
      nested: { enabled: true },
      tags: ["a", { deep: 1 }],
    });
    assert.ok(Object.isFrozen(operation.value));
    assert.ok(Object.isFrozen(operation.value.nested));
    assert.ok(Object.isFrozen(operation.value.tags));
    assert.ok(Object.isFrozen(operation.value.tags[1]));

    for (const invalid of [undefined, Number.NaN, Infinity, 1n, () => {}, Symbol()]) {
      assertWireError(
        () => decodeClientBatch(Board, valueBatch(invalid)),
        "/operations/0/value"
      );
    }
    assertWireError(
      () => decodeClientBatch(Board, valueBatch(new Date())),
      "/operations/0/value"
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assertWireError(
      () => decodeClientBatch(Board, valueBatch(cyclic)),
      "/operations/0/value/self"
    );
  });

  it("still copies and freezes null-prototype JSON after local validation", () => {
    const dictionary: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Only string data properties are added to this null-prototype fixture.
    dictionary.nested = { ok: true };
    const Data = defineDocument({ meta: valueSchema<JsonValue>(dictionary) });
    const local = createClient(Data, { clientId: "dictionary", onBatch() {} });
    local.state.meta.set(dictionary);
    const decoded = decodeClientBatch(Data, local.checkpoint().pendingBatches[0]);
    const copied = decoded.operations[0]!.value;
    assert.notStrictEqual(copied, dictionary);
    assert.equal(Object.isFrozen(dictionary), false);
    assert.ok(typeof copied === "object" && copied !== null && !Array.isArray(copied));
    assert.ok(Object.isFrozen(copied));
    assert.ok(Object.isFrozen(copied.nested));
    assert.equal(Object.getPrototypeOf(copied), Object.prototype);
    assert.deepEqual(copied, { nested: { ok: true } });
  });

  it("copies and freezes 20,000 levels of mixed JSON containers without recursion", () => {
    const Data = defineDocument({ meta: valueSchema<JsonValue>(null) });
    const depth = 10_000;
    const input: unknown = JSON.parse('[{"next":'.repeat(depth) + '0' + '}]'.repeat(depth));
    const operation = decodeClientBatch(Data, valueBatch(input)).operations[0]!;
    assert.equal(operation.type, "value/set");
    let original: unknown = input;
    let copied: unknown = operation.value;
    for (let index = 0; index < depth; index++) {
      assert.ok(Array.isArray(original));
      assert.ok(Array.isArray(copied));
      assert.notStrictEqual(copied, original);
      assert.ok(Object.isFrozen(copied));
      original = original[0];
      copied = copied[0];
      assert.ok(typeof original === "object" && original !== null && "next" in original);
      assert.ok(typeof copied === "object" && copied !== null && "next" in copied);
      assert.notStrictEqual(copied, original);
      assert.ok(Object.isFrozen(copied));
      original = original.next;
      copied = copied.next;
    }
    assert.equal(original, 0);
    assert.equal(copied, 0);
  });

  it("reports deep invalid leaves and cycles with escaped JSON Pointer paths", () => {
    const depth = 20_000;
    let invalid: unknown = Infinity;
    const cycle: Record<string, unknown> = {};
    let cyclic: unknown = cycle;
    for (let index = 0; index < depth; index++) {
      invalid = { "a/~": invalid };
      cyclic = { "a/~": cyclic };
    }
    cycle.back = cyclic;
    const path = "/operations/0/value" + "/a~1~0".repeat(depth);
    assertWireError(() => decodeClientBatch(Board, valueBatch(invalid)), path);
    assertWireError(() => decodeClientBatch(Board, valueBatch(cyclic)), path + "/back");
  });

  it("copies shared JSON branches separately without treating them as cycles", () => {
    const Data = defineDocument({ meta: valueSchema<JsonValue>(null) });
    const shared = { nested: [1] };
    const input = { left: shared, right: shared, ["__proto__"]: { safe: true } };
    const decoded = decodeClientBatch(Data, valueBatch(input)).operations[0]!.value;
    assert.ok(typeof decoded === "object" && decoded !== null && !Array.isArray(decoded));
    assert.notStrictEqual(decoded.left, shared);
    assert.notStrictEqual(decoded.left, decoded.right);
    assert.ok(Object.isFrozen(decoded.left));
    assert.ok(Object.isFrozen(decoded.right));
    assert.ok(Object.hasOwn(decoded, "__proto__"));
    shared.nested[0] = 9;
    assert.deepEqual(decoded, {
      left: { nested: [1] }, right: { nested: [1] }, ["__proto__"]: { safe: true },
    });
  });

  it("rejects nested sparse arrays and invalid descriptors without invoking getters", () => {
    let reads = 0;
    const getter = () => { reads++; return 1; };
    const object = Object.defineProperty({}, "bad/~", { get: getter, enumerable: true });
    assertWireError(
      () => decodeClientBatch(Board, valueBatch({ nested: object })),
      "/operations/0/value/nested/bad~1~0"
    );
    const array = Object.defineProperty([0], "0", { get: getter, enumerable: true });
    assertWireError(
      () => decodeClientBatch(Board, valueBatch({ nested: array })),
      "/operations/0/value/nested/0"
    );
    assert.equal(reads, 0);
    for (const invalid of [new Array<unknown>(1), { [Symbol("key")]: 1 }]) {
      assertWireError(
        () => decodeClientBatch(Board, valueBatch({ nested: invalid })),
        "/operations/0/value/nested"
      );
    }
    const hidden = Object.defineProperty({}, "hidden", { value: 1 });
    assertWireError(
      () => decodeClientBatch(Board, valueBatch({ nested: hidden })),
      "/operations/0/value/nested/hidden"
    );
  });

  it("distinguishes structural decoding from stateful runtime validation", () => {
    assertWireError(
      () =>
        decodeClientBatch(Board, {
          clientId: "client-1",
          seq: 1,
          operations: [],
        }),
      "/operations"
    );

    const rejectedCommit = decodeServerCommit(Board, {
      serverSeq: 1,
      source: { clientId: "client-1", seq: 1 },
      operations: [],
    });
    assert.deepEqual(rejectedCommit.operations, []);
    assert.ok(Object.isFrozen(rejectedCommit.operations));

    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    const structurallyValid = decodeClientBatch(Board, {
      clientId: "client-1",
      seq: 1,
      operations: [
        {
          type: "text/insert",
          path: "body",
          before: { bunchId: "missing", counter: 0 },
          id: { bunchId: JSON.stringify(["client-1", "body", 1]), counter: 0 },
          value: "a",
        },
      ],
    });
    assert.throws(
      () => server.receive(structurallyValid),
      /Unknown text insertion anchor/
    );
    assert.deepEqual(server.snapshot(), {
      serverSeq: 0,
      data: {
        meta: { status: "draft", nested: { enabled: false }, tags: [] },
        items: { idList: [], values: [] },
        body: { idList: [], value: "" },
      },
    });

    const valid = decodeClientBatch(Board, {
      clientId: "client-1",
      seq: 1,
      operations: [
        {
          type: "text/insert",
          path: "body",
          before: null,
          id: { bunchId: JSON.stringify(["client-1", "body", 1]), counter: 0 },
          value: "a",
        },
      ],
    });
    assert.equal(server.receive(valid).commit.serverSeq, 1);
  });

  it("streams huge Text delete ranges before rejecting unknown ids", () => {
    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    const id = { bunchId: JSON.stringify(["client-1", "body", 1]), counter: 0 };
    const first = decodeClientBatch(Board, {
      clientId: "client-1",
      seq: 1,
      operations: [
        {
          type: "text/insert",
          path: "body",
          before: null,
          id,
          value: "a",
        },
      ],
    });
    assert.equal(server.receive(first).commit.serverSeq, 1);

    const hugeDelete = decodeClientBatch(Board, {
      clientId: "client-1",
      seq: 2,
      operations: [
        {
          type: "text/delete",
          path: "body",
          ranges: [
            {
              start: id,
              count: Number.MAX_SAFE_INTEGER,
            },
          ],
        },
      ],
    });
    assert.throws(() => server.receive(hugeDelete), {
      message: `Unknown text element id: ${JSON.stringify([id.bunchId, 1])}`,
    });
    assert.equal(server.snapshot().serverSeq, 1);

    const validDelete = decodeClientBatch(Board, {
      clientId: "client-1",
      seq: 2,
      operations: [
        {
          type: "text/delete",
          path: "body",
          ranges: [
            { start: id, count: 1 },
          ],
        },
      ],
    });
    assert.equal(server.receive(validDelete).commit.serverSeq, 2);
  });

  it("rejects invalid snapshot shape and collection invariants", () => {
    assertWireError(
      () =>
        decodeSnapshot(Board, {
          serverSeq: 0,
          data: {
            meta: { status: "draft", nested: { enabled: false }, tags: [] },
            items: { idList: [], values: [] },
            body: { idList: [], value: "" },
            extra: null,
          },
        }),
      "/data/extra"
    );
    assertWireError(
      () =>
        decodeSnapshot(Board, {
          serverSeq: 0,
          data: {
            meta: { status: "draft", nested: { enabled: false }, tags: [] },
            items: {
              idList: [
                {
                  bunchId: "one",
                  startCounter: 0,
                  count: 1,
                  isDeleted: false,
                },
              ],
              values: [],
            },
            body: { idList: [], value: "" },
          },
        }),
      "/data/items"
    );
    assertWireError(
      () =>
        decodeSnapshot(Board, {
          serverSeq: 0,
          data: {
            meta: { status: "draft", nested: { enabled: false }, tags: [] },
            items: { idList: [], values: [] },
            body: {
              idList: [
                {
                  bunchId: "one",
                  startCounter: 0,
                  count: 2,
                  isDeleted: false,
                },
              ],
              value: "a",
            },
          },
        }),
      "/data/body"
    );
    assertWireError(
      () =>
        decodeSnapshot(Board, {
          serverSeq: 0,
          data: {
            meta: { status: "draft", nested: { enabled: false }, tags: [] },
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
              values: [{ label: "a" }, { label: "b" }],
            },
            body: { idList: [], value: "" },
          },
        }),
      "/data/items/idList/1/startCounter"
    );
  });

  it("rejects invalid server checkpoint structure and metadata", () => {
    const replay = (clientId: string, seq: number, serverSeq: number) => ({
      batch: { clientId, seq, operations: [{ type: "text/insert", path: "body",
        before: null, id: { bunchId: clientId, counter: 0 }, value: "A" }] },
      commit: { serverSeq, source: { clientId, seq }, operations: [] },
    });
    const snapshot = {
      serverSeq: 2,
      data: {
        meta: { status: "draft", nested: { enabled: false }, tags: [] },
        items: { idList: [], values: [] },
        body: { idList: [], value: "" },
      },
    };

    assertWireError(
      () => decodeServerCheckpoint(Board, { lastClientNumber: 4, clients: [] }),
      "/snapshot"
    );
    assertWireError(
      () =>
        decodeServerCheckpoint(Board, {
          snapshot,
          history: [],
          lastClientNumber: 4, clients: [],
          extra: true,
        }),
      "/extra"
    );
    assertWireError(
      () =>
        decodeServerCheckpoint(Board, {
          snapshot,
          history: [],
          lastClientNumber: 4, clients: [
            replay("client-1", 1, 1),
            replay("client-1", 1, 2),
          ].map((savedReplay) => ({ clientId: savedReplay.batch.clientId, replay: savedReplay })),
        }),
      "/clients/1/clientId"
    );
    assertWireError(
      () =>
        decodeServerCheckpoint(Board, {
          snapshot,
          history: [],
          lastClientNumber: 4, clients: [replay("client-1", 3, 1)].map((savedReplay) => ({ clientId: savedReplay.batch.clientId, replay: savedReplay })),
        }),
      "/clients/0/replay/commit/serverSeq"
    );
    assertWireError(
      () =>
        decodeServerCheckpoint(Board, {
          snapshot: { ...snapshot, serverSeq: 0 },
          history: [],
          lastClientNumber: 4, clients: [replay("client-1", 0, 1)].map((savedReplay) => ({ clientId: savedReplay.batch.clientId, replay: savedReplay })),
        }),
      "/clients/0/replay/batch/seq"
    );
    assertWireError(
      () =>
        decodeServerCheckpoint(Board, {
          snapshot: {
            ...snapshot,
            data: { ...snapshot.data, body: undefined },
          },
          history: [],
          lastClientNumber: 4, clients: [
            replay("client-1", 1, 1),
            replay("client-2", 1, 2),
          ].map((savedReplay) => ({ clientId: savedReplay.batch.clientId, replay: savedReplay })),
        }),
      "/snapshot/data/body"
    );

    const sparseBatches = new Array<unknown>(1);
    assertWireError(
      () =>
        decodeServerCheckpoint(Board, {
          snapshot: { ...snapshot, serverSeq: 0 },
          history: [],
          lastClientNumber: 4, clients: sparseBatches,
        }),
      "/clients"
    );
  });

  it("validates replay metadata and preserves nested JSON Pointer paths", () => {
    const server = createServer(Board);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    const a = setupClient("client-1");
    const b = setupClient("client-2");
    a.doc.state.body.insert(0, "A");
    b.doc.state.body.insert(0, "B");
    server.receive(a.batches[0]!);
    server.receive(b.batches[0]!);
    const valid = server.checkpoint();
    const first = valid.clients[0]!.replay!;
    const second = valid.clients[1]!.replay!;
    const operation = first.batch.operations[0]!;
    assert.equal(operation.type, "text/insert");
    if (operation.type !== "text/insert") return;
    const withFirst = (entry: unknown, serverSeq = 2) => ({
      snapshot: { ...valid.snapshot, serverSeq },
      history: [],
      lastClientNumber: 4, clients: [{ clientId: "client-1", replay: entry }, { clientId: "client-2", replay: second }],
    });
    const withCommit = (commit: unknown) => withFirst({ ...first, commit });
    const cases: Array<[string, unknown]> = [
      ["/clients/0/replay/batch", withFirst({ commit: first.commit })],
      ["/clients/0/replay/commit", withFirst({ batch: first.batch })],
      ["/clients/0/replay/extra", withFirst({ ...first, extra: true })],
      ["/clients/0/replay/batch/operations", withFirst({
        ...first, batch: { ...first.batch, operations: [] },
      })],
      ["/clients/0/replay/batch/operations/0/id/counter", withFirst({
        ...first, batch: { ...first.batch, operations: [
          { ...operation, id: { ...operation.id, counter: -1 } },
        ] },
      })],
      ["/clients/0/replay/commit/source/clientId", withCommit({
        ...first.commit, source: { ...first.commit.source, clientId: "wrong" },
      })],
      ["/clients/0/replay/commit/source/seq", withCommit({
        ...first.commit, source: { ...first.commit.source, seq: 2 },
      })],
      ["/clients/0/replay/commit/serverSeq", withCommit({ ...first.commit, serverSeq: 3 })],
      ["/clients/0/replay/commit/serverSeq", withCommit({ ...first.commit, serverSeq: 0 })],
      ["/clients/1/replay/commit/serverSeq", { ...valid, lastClientNumber: 4, clients: [first, {
        ...second, commit: { ...second.commit, serverSeq: 1 },
      }].map((savedReplay) => ({ clientId: savedReplay.batch.clientId, replay: savedReplay })) }],
      ["/clients/0/replay/commit/operations/0/value", withCommit({
        ...first.commit, operations: [{ ...operation, value: "" }],
      })],
      ["/clients/0/replay/commit/serverSeq", withFirst({ // A client second batch cannot be the first global commit.
        batch: { ...first.batch, seq: 2 },
        commit: { ...first.commit, source: { ...first.commit.source, seq: 2 } },
      }, 3)],
    ];
    for (const [path, input] of cases) {
      assertWireError(() => decodeServerCheckpoint(Board, input), path);
      assert.throws(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
        () => createServer(Board, { checkpoint: input as typeof valid }),
        WireDecodeError
      );
    }
  });

  it("owns and freezes replay payloads, IDs, ranges, and empty reject commits", () => {
    const id = { bunchId: "a", counter: 0 };
    const input = {
      snapshot: { serverSeq: 1, data: {
        meta: { status: "draft", nested: { enabled: false }, tags: [] },
        items: { idList: [], values: [] }, body: { idList: [], value: "" },
      } },
      history: [],
      lastClientNumber: 4, clients: [{
        batch: { clientId: "client-1", seq: 1, operations: [
          { type: "list/insert", path: "items", before: null, id, value: { label: "original" } },
          { type: "text/delete", path: "body", ranges: [{ start: id, count: 1 }] },
        ] },
        commit: { serverSeq: 1, source: { clientId: "client-1", seq: 1 }, operations: [] },
      }].map((savedReplay) => ({ clientId: savedReplay.batch.clientId, replay: savedReplay })),
    };
    const checkpoint = decodeServerCheckpoint(Board, input);
    const entry = checkpoint.clients[0]!.replay!;
    const insert = entry.batch.operations[0]!;
    const deletion = entry.batch.operations[1]!;
    assert.equal(insert.type, "list/insert");
    assert.equal(deletion.type, "text/delete");
    if (insert.type !== "list/insert" || deletion.type !== "text/delete") return;
    for (const container of [checkpoint.clients, entry, entry.batch, entry.batch.operations,
      insert, insert.id, insert.value, deletion, deletion.ranges, deletion.ranges[0],
      deletion.ranges[0]!.start, entry.commit, entry.commit.source, entry.commit.operations]) {
      assert.ok(Object.isFrozen(container));
    }
    const mutableValue = input.clients[0]!.replay.batch.operations[0]!.value;
    assert.ok(mutableValue !== undefined);
    mutableValue.label = "changed";
    id.counter = 99;
    input.clients[0]!.replay.commit.source.clientId = "changed";
    assert.equal(insert.value.label, "original");
    assert.equal(insert.id.counter, 0);
    assert.equal(deletion.ranges[0]!.start.counter, 0);
    assert.equal(entry.commit.source.clientId, "client-1");
    const restored = createServer(Board, { checkpoint });
    assert.equal(restored.receive(entry.batch).replayed, true);
    assert.deepEqual(restored.snapshot(), checkpoint.snapshot);
  });

  it("rejects replay sequences that cannot form an ordered commit history", () => {
    const replayEntry = (clientId: string, seq: number, serverSeq: number) => ({
      batch: {
        clientId,
        seq,
        operations: [{
          type: "value/set" as const,
          path: "meta" as const,
          value: { status: "draft", nested: { enabled: false }, tags: [] },
        }],
      },
      commit: { serverSeq, source: { clientId, seq }, operations: [] },
    });
    const cases = [
      // A second batch cannot have been accepted at the first global commit.
      { serverSeq: 3, lastClientNumber: 4, clients: [replayEntry("client-1", 2, 1), replayEntry("client-2", 1, 3)].map((savedReplay) => ({ clientId: savedReplay.batch.clientId, replay: savedReplay })), path: "/clients/0/replay/commit/serverSeq" },
      // By commit 3, a and b cannot already have completed four batches.
      { serverSeq: 5, lastClientNumber: 4, clients: [replayEntry("client-1", 2, 2), replayEntry("client-2", 2, 3), replayEntry("client-3", 1, 5)].map((savedReplay) => ({ clientId: savedReplay.batch.clientId, replay: savedReplay })), path: "/clients/1/replay/commit/serverSeq" },
    ];
    for (const { serverSeq, lastClientNumber, clients, path } of cases) {
      const input = { snapshot: { ...createServer(Board).snapshot(), serverSeq }, lastClientNumber, clients, history: [] };
      assertWireError(() => decodeServerCheckpoint(Board, input), path);
      assert.throws(
        () => createServer(Board, { checkpoint: input }),
        WireDecodeError
      );
    }

    // Entry array order need not match global commit order.
    const input = {
      snapshot: { ...createServer(Board).snapshot(), serverSeq: 5 },
      history: [],
      lastClientNumber: 4, clients: [replayEntry("client-3", 1, 5), replayEntry("client-2", 2, 4), replayEntry("client-1", 2, 2)].map((savedReplay) => ({ clientId: savedReplay.batch.clientId, replay: savedReplay })),
    };
    const checkpoint = decodeServerCheckpoint(Board, input);
    assert.deepEqual(checkpoint.clients.map((entry) => entry.clientId), ["client-3", "client-2", "client-1"]);
    assert.deepEqual(createServer(Board, { checkpoint }).snapshot(), checkpoint.snapshot);
  });
});
