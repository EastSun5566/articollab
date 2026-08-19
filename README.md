# Articula

Articula is a small TypeScript library for building server-authoritative collaborative collections on top of [articulated](https://github.com/mweidner037/articulated).

The project is intentionally early and minimal. Its first slice provides a typed document schema, optimistic values, explicit transactions, outbound client batches, and change subscriptions. Server reconciliation, lists, and text are planned next.

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

const unsubscribe = doc.on("change", () => {
  console.log(doc.state.count.value);
});
```

Values must be JSON-compatible and are treated as immutable. Each mutation outside a transaction creates one client batch. A transaction groups all of its synchronous mutations into one batch and emits one change event.

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

Not implemented yet:

- Server commits, acknowledgements, rejection, or pending-operation replay
- `List<T>` and `Text` backed by articulated stable IDs
- Persistence, transports, presence, or undo history
