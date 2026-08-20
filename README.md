# Articula

Articula is a small TypeScript library for building server-authoritative collaborative collections on top of [articulated](https://github.com/mweidner037/articulated).

The project is intentionally early and minimal. It provides a typed document schema, optimistic values, explicit transactions, outbound client batches, and client-side server reconciliation. Lists, text, and a server runtime are planned next.

## Example

```ts
import { createClient, defineDocument, value } from "articula";

const Counter = defineDocument({
  count: value(0),
});

const doc = createClient(Counter, {
  clientId: crypto.randomUUID(),
  onBatch: (batch) => sendLater(batch),
});

doc.state.count.value = 1;

doc.transact(() => {
  doc.state.count.value = 2;
  doc.state.count.value = 3;
});

const unsubscribe = doc.on("change", (event) => {
  console.log(event.origin, doc.state.count.value);
});

// Receive authoritative commits in serverSeq order.
doc.receive({
  serverSeq: 1,
  source: { clientId: "another-client", seq: 1 },
  operations: [{ type: "value/set", path: "count", value: 4 }],
});
```

Values must be JSON-compatible and are treated as immutable. Each mutation outside a transaction creates one client batch. A transaction groups all of its synchronous mutations into one batch and emits one change event.

The client keeps local batches pending until their matching server commits arrive. On each commit, it updates its authoritative state, removes the acknowledged local batch when applicable, then replays the remaining pending batches. A commit with no operations rolls back the matching optimistic batch. Commits must arrive exactly once, starting at `serverSeq: 1`, and `receive()` must not be called inside `transact()`.

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

Not implemented yet:

- Server runtime, transports, snapshots, reconnects, or late joins
- `List<T>` and `Text` backed by articulated stable IDs
- Persistence, presence, or undo history
