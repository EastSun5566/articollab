import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient,
  createServer,
  decodeClientBatch,
  decodeServerCommit,
  decodeSnapshot,
  defineDocument,
  list,
  text,
  value,
  WireDecodeError,
  type ClientBatch,
  type DocumentOperation,
  type JsonValue,
} from "../src/index.ts";

const Board = defineDocument({
  meta: value<{
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
    assert.match(error.message, new RegExp(`at ${path.replaceAll("/", "\\/")}:`));
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
  it("round-trips Value, List, and Text batches and commits", () => {
    const server = createServer(Board);
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
      jsonRoundTrip(server.receive(batch))
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
        )
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
        )
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
        )
      )
    );
    client1.doc.receive(insertCommit);
    client2.doc.receive(insertCommit);
    lateClient.receive(insertCommit);
    assert.equal(client1.doc.state.body.toString(), "B");
    assert.equal(client2.doc.state.body.toString(), "B");
    assert.equal(lateClient.state.body.toString(), "B");
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
    const structurallyValid = decodeClientBatch(Board, {
      clientId: "client-1",
      seq: 1,
      operations: [
        {
          type: "text/insert",
          path: "body",
          before: { bunchId: "missing", counter: 0 },
          id: { bunchId: "one", counter: 0 },
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
          id: { bunchId: "one", counter: 0 },
          value: "a",
        },
      ],
    });
    assert.equal(server.receive(valid).serverSeq, 1);
  });

  it("streams huge Text delete ranges before rejecting unknown ids", () => {
    const server = createServer(Board);
    const first = decodeClientBatch(Board, {
      clientId: "client-1",
      seq: 1,
      operations: [
        {
          type: "text/insert",
          path: "body",
          before: null,
          id: { bunchId: "one", counter: 0 },
          value: "a",
        },
      ],
    });
    assert.equal(server.receive(first).serverSeq, 1);

    const hugeDelete = decodeClientBatch(Board, {
      clientId: "client-1",
      seq: 2,
      operations: [
        {
          type: "text/delete",
          path: "body",
          ranges: [
            {
              start: { bunchId: "one", counter: 0 },
              count: Number.MAX_SAFE_INTEGER,
            },
          ],
        },
      ],
    });
    assert.throws(() => server.receive(hugeDelete), /counter.*1|\["one",1\]/i);
    assert.equal(server.snapshot().serverSeq, 1);

    const validDelete = decodeClientBatch(Board, {
      clientId: "client-1",
      seq: 2,
      operations: [
        {
          type: "text/delete",
          path: "body",
          ranges: [
            { start: { bunchId: "one", counter: 0 }, count: 1 },
          ],
        },
      ],
    });
    assert.equal(server.receive(validDelete).serverSeq, 2);
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
});
