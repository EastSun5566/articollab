# Articula

Articula is a small TypeScript library for building server-authoritative collaborative collections on top of [articulated](https://github.com/mweidner037/articulated).

The project is intentionally early and minimal. It provides a typed document schema, optimistic values, explicit transactions, client-side reconciliation, snapshot hydration, and a synchronous authoritative server runtime. Lists, text, and production transports are planned next.

## Example

```ts
import { createClient, createServer, defineDocument, value } from "articula";

const Counter = defineDocument({
  count: value(0),
});

const server = createServer(Counter);
const clients = new Set();
const commitQueue = [];
let broadcasting = false;

function send(batch) {
  commitQueue.push(server.receive(batch));
  if (broadcasting) return;

  broadcasting = true;
  try {
    while (commitQueue.length > 0) {
      const commit = commitQueue.shift();
      for (const client of clients) client.receive(commit);
    }
  } finally {
    broadcasting = false;
  }
}

function connect(clientId) {
  const doc = createClient(Counter, {
    clientId,
    snapshot: server.snapshot(),
    onBatch: send,
  });
  clients.add(doc);
  return doc;
}

const doc = connect(crypto.randomUUID());

doc.state.count.value = 1;

doc.transact(() => {
  doc.state.count.value = 2;
  doc.state.count.value = 3;
});

const unsubscribe = doc.on("change", (event) => {
  console.log(event.origin, doc.state.count.value);
});

const lateDoc = connect(crypto.randomUUID());
console.log(lateDoc.state.count.value); // 3
```

Values must be JSON-compatible and are treated as immutable. Each mutation outside a transaction creates one client batch. A transaction groups all of its synchronous mutations into one batch and emits one change event.

The client keeps local batches pending until their matching server commits arrive. On each commit, it updates its authoritative state, removes the acknowledged local batch when applicable, then replays the remaining pending batches. A commit with no operations rolls back the matching optimistic batch. Commits must arrive exactly once, starting at `serverSeq: 1`, and `receive()` must not be called inside `transact()`.

The server accepts batches unchanged and assigns their total order synchronously. That order is exactly the order of `server.receive(batch)` calls. Each client's batches must arrive exactly once, starting at `seq: 1`. The caller is responsible for broadcasting each returned commit to every client, including its sender. The example queues commits so a change listener cannot interrupt one broadcast with the next commit.

`server.snapshot()` returns the current authoritative values together with the latest `serverSeq`. A new client using the same `DocumentSchema` can hydrate from that snapshot and then expects the following commit. Snapshots do not include a schema ID or version, and Articula does not provide schema migration. A real transport must obtain the snapshot and subscribe to later commits without leaving a gap; Articula does not retain commit history or manage connected clients. Snapshot containers are frozen, while nested JSON values follow the same immutable-value contract as `Value<T>`.

## Development

Requires Node.js 24 or newer and pnpm 10.

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

Tests run the TypeScript source directly with Node.js's native test runner. Type checking and builds use TypeScript 7's standard `tsc` executable; production builds emit only `src` into `dist`.

## Current scope

Implemented:

- Typed fixed document schemas
- JSON-compatible `Value<T>` collections
- Optimistic local mutations
- Explicit transaction batching
- Document-level change subscriptions
- Ordered authoritative server commits
- Local acknowledgement and pending-operation replay
- Rejected or server-transformed operations
- Synchronous accept-only server runtime
- Snapshot hydration for new clients
- Late join from the current authoritative state

Not implemented yet:

- Server policies, transports, reconnects, or server restore
- `List<T>` and `Text` backed by articulated stable IDs
- Persistence, presence, or undo history
