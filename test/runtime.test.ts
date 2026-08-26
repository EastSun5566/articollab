import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient,
  createServer,
  defineDocument,
  value,
  type ChangeEvent,
  type ClientBatch,
  type DocumentOperation,
  type DocumentSnapshot,
  type ServerDocument,
  type ServerCommit,
} from "../src/index.ts";

const Counter = defineDocument({
  count: value(0),
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

if (false) {
  const { doc } = setup();
  // @ts-expect-error Transactions must not continue after an await.
  doc.transact(async () => {});

  createServer(Counter, {
    // @ts-expect-error Server resolvers must return operations synchronously.
    resolve: async ({ batch }) => batch.operations,
  });
}

describe("client runtime", () => {
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
    } as unknown as CounterCommit;

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
    const commits: CounterCommit[] = [];
    const receivers: Array<(commit: CounterCommit) => void> = [];
    const commitQueue: CounterCommit[] = [];
    let broadcasting = false;
    const send = (batch: ClientBatch<CounterOperation>) => {
      const commit = server.receive(batch);
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
    const receivers: Array<(commit: CounterCommit) => void> = [];
    const commitQueue: CounterCommit[] = [];
    let broadcasting = false;
    const send = (batch: ClientBatch<CounterOperation>) => {
      commitQueue.push(server.receive(batch));
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

    const client2Commit = server.receive(client2Batches[0]!);
    client1.receive(client2Commit);
    client2.receive(client2Commit);
    assert.equal(client1.state.count.value, 1);
    assert.equal(client2.state.count.value, 2);

    const client1Commit = server.receive(client1Batches[0]!);
    client1.receive(client1Commit);
    client2.receive(client1Commit);

    assert.equal(client1Commit.serverSeq, 2);
    assert.equal(client1.state.count.value, 1);
    assert.equal(client2.state.count.value, 1);
  });

  it("rejects invalid batches without consuming sequence numbers", () => {
    const server = createServer(Counter);

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
    });
    assert.equal(firstCommit.serverSeq, 1);

    assert.throws(
      () =>
        server.receive({
          clientId: "client-1",
          seq: 1,
          operations: [{ type: "value/set", path: "count", value: 2 }],
        }),
      /Expected client sequence 2/
    );

    const unknownPathBatch = {
      clientId: "client-2",
      seq: 1,
      operations: [{ type: "value/set", path: "missing", value: 2 }],
    } as unknown as ClientBatch<CounterOperation>;
    assert.throws(
      () => server.receive(unknownPathBatch),
      /Unknown document path: missing/
    );

    const secondCommit = server.receive({
      clientId: "client-2",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 2 }],
    });
    assert.equal(secondCommit.serverSeq, 2);
  });

  it("owns an immutable snapshot of accepted operations", () => {
    const server = createServer(Counter);
    const operations = [
      { type: "value/set" as const, path: "count" as const, value: 1 },
    ];

    const commit = server.receive({
      clientId: "client-1",
      seq: 1,
      operations,
    });
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
    const commit = server.receive(batches[0]!);
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
    const batches: ClientBatch<CounterOperation>[] = [];
    const client = createClient(Counter, {
      clientId: "client-1",
      onBatch: (batch) => batches.push(batch),
    });

    client.state.count.value = 1;
    const commit = server.receive(batches[0]!);
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
      resolve: ({ batch }) => {
        switch (mode) {
          case "throw":
            throw new Error("policy failed");
          case "non-array":
            return undefined as unknown as readonly CounterOperation[];
          case "invalid-path":
            return [
              { type: "value/set", path: "missing", value: 9 },
            ] as unknown as readonly CounterOperation[];
          case "unknown-type":
            return [
              {
                type: "bogus",
                path: "count",
                id: { bunchId: "invalid", counter: 0 },
              },
            ] as unknown as readonly CounterOperation[];
          case "reentrant":
            server.receive({
              clientId: "nested",
              seq: 1,
              operations: [{ type: "value/set", path: "count", value: 9 }],
            });
            return batch.operations;
          case "accept":
            return batch.operations;
        }
      },
    });
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
    const firstCommit = server.receive(batch);
    const secondCommit = server.receive({
      clientId: "nested",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 2 }],
    });
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
    const firstCommit = server.receive({
      clientId: "client-1",
      seq: 1,
      operations: [{ type: "value/set", path: "count", value: 1 }],
    });
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
    });
    lateClient.receive(secondCommit);

    assert.equal(lateClient.state.count.value, 2);
  });

  it("starts a late client's sequence at one and converges all clients", () => {
    const server = createServer(Counter);
    let firstBatch: ClientBatch<CounterOperation> | undefined;
    const firstClient = createClient(Counter, {
      clientId: "client-1",
      onBatch: (batch) => {
        firstBatch = batch;
      },
    });
    firstClient.state.count.value = 1;
    const firstCommit = server.receive(firstBatch!);
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
    const secondCommit = server.receive(lateBatch!);
    firstClient.receive(secondCommit);
    lateClient.receive(secondCommit);

    assert.equal(secondCommit.serverSeq, 2);
    assert.equal(firstClient.state.count.value, 2);
    assert.equal(lateClient.state.count.value, 2);
  });

  it("keeps snapshots point-in-time and rejects invalid hydration data", () => {
    const server = createServer(Counter);
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
      /non-negative integer/
    );
    assert.throws(
      () =>
        createFrom({
          serverSeq: 0,
          data: {} as { readonly count: number },
        }),
      /Missing snapshot path: count/
    );
    assert.throws(
      () =>
        createFrom({
          serverSeq: 0,
          data: { count: 0, extra: true },
        } as unknown as DocumentSnapshot<typeof Counter.definition>),
      /Unknown snapshot path: extra/
    );
  });
});
