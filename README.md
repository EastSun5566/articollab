# Articula

Articula is a small TypeScript library for building server-authoritative collaborative collections on top of [articulated](https://github.com/mweidner037/articulated).

The project is intentionally early and minimal. It provides a typed document schema, optimistic values, lists, and plain text, explicit transactions, client-side reconciliation, snapshot hydration, and a synchronous authoritative server runtime with batch policies. Production transports are planned next.

## Example

```ts
import {
  createClient,
  createServer,
  decodeClientBatch,
  decodeServerCheckpoint,
  decodeServerCommit,
  decodeSnapshot,
  defineDocument,
  list,
  text,
  value,
} from "articula";

const Board = defineDocument({
  count: value(0),
  items: list<string>(),
  body: text(),
});

const server = createServer(Board, {
  resolve({ batch, snapshot }) {
    const insertsItem = batch.operations.some(
      (operation) => operation.type === "list/insert"
    );
    if (insertsItem && snapshot.data.items.values.length >= 100) {
      return []; // Reject the whole optimistic batch.
    }
    return batch.operations;
  },
});
const clients = new Map();
const commitQueue = [];
let broadcasting = false;

function send(batch) {
  const { commit, replayed } = server.receive(batch);
  const recipients = replayed
    ? [clients.get(batch.clientId)]
    : [...clients.values()];
  commitQueue.push({ commit, recipients });
  if (broadcasting) return;

  broadcasting = true;
  try {
    while (commitQueue.length > 0) {
      const { commit, recipients } = commitQueue.shift();
      for (const client of recipients) client.receive(commit);
    }
  } finally {
    broadcasting = false;
  }
}

function connect(clientId) {
  const doc = createClient(Board, {
    clientId,
    snapshot: server.snapshot(),
    onBatch: send,
  });
  clients.set(clientId, doc);
  return doc;
}

const doc = connect(crypto.randomUUID());

doc.state.count.value = 1;
doc.state.items.push("Write tests");
doc.state.body.insert(0, "Hello 😀");

doc.transact(() => {
  doc.state.count.value = 2;
  doc.state.count.value = 3;
  doc.state.items.insert(0, "Design API");
  doc.state.body.delete(5, 1);
});

const unsubscribe = doc.on("change", (event) => {
  console.log(event.origin, doc.state.count.value);
});

const lateDoc = connect(crypto.randomUUID());
console.log(lateDoc.state.count.value); // 3
console.log(lateDoc.state.items.toArray()); // ["Design API", "Write tests"]
console.log(lateDoc.state.body.toString()); // "Hello😀"
```

Values and list elements must be JSON-compatible and are treated as immutable. Lists support single-element `insert`, `push`, and `delete`, plus array-like reads and iteration. Text supports range `insert` and `delete`, string conversion, and iteration by Unicode code point; indexes therefore do not always match JavaScript's UTF-16 `string.length`. List and text wire operations use articulated stable IDs instead of mutable indexes, so pending insertions can still reference an element after it becomes a tombstone. Text inserts allocate consecutive ID ranges, while deletes compress their targets into consecutive ranges. Each mutation outside a transaction creates one client batch. A transaction groups all of its synchronous mutations into one batch and emits one change event.

The client keeps local batches pending until their matching server commits arrive. On each commit, it updates its authoritative state, removes the acknowledged local batch when applicable, then replays the remaining pending batches. A commit with no operations rolls back the matching optimistic batch. Commits must arrive exactly once, starting at `serverSeq: 1`, and `receive()` must not be called inside `transact()`.

The server assigns new batches a total order synchronously, in the order of `server.receive(batch)` calls that return `replayed: false`. An optional batch-level `resolve` callback receives a frozen owned batch and the authoritative snapshot from immediately before that batch. Returning the original operations accepts it, returning different operations transforms it, and returning an empty array rejects its authoritative effect while still acknowledging the batch. A resolver should be a pure synchronous decision: throwing, returning a non-array, producing an invalid operation, or calling the same server's `receive()` reentrantly aborts without consuming sequence numbers. When reusing an incoming text insertion ID, a resolver should preserve its code-point length; a different-length or server-created insertion requires an application-supplied globally unique ID range that cannot collide with client pending IDs.

Each client's new batches must arrive in sequence, starting at `seq: 1`. `server.receive()` returns a frozen `{ commit, replayed }` receipt. Broadcast new commits to every client, including their sender. If the sender missed the response, it may resend its last batch: an identical retry returns the saved commit with `replayed: true`, without rerunning the resolver or advancing state or sequences. Send that replay only to the source awaiting the commit. The receipt itself is routing metadata, not a wire message. The example queues deliveries so a change listener cannot interrupt one broadcast with the next commit.

Only the last successful batch per client is retained. Older retries, sequence gaps, and retries with different operations throw. JSON object key order is ignored when comparing retries; array and operation order matters. The caller retains unresolved batches from `onBatch` and decides when to retry. Clients still require exactly-once, ordered commits: a transport must discard responses the client already consumed and must deliver earlier commits before a replay. Retrying one batch does not catch up other peers that missed commits.

Sequences stay within JavaScript's safe integer range. Once the global sequence reaches `Number.MAX_SAFE_INTEGER`, new batches throw without running the resolver or changing state; retained retries remain available.

At a transport boundary, decode parsed JSON before passing it to the typed runtime:

```ts
const batch = decodeClientBatch(Board, JSON.parse(batchMessage));
const { commit, replayed } = server.receive(batch);

doc.receive(decodeServerCommit(Board, JSON.parse(commitMessage)));

const snapshot = decodeSnapshot(Board, JSON.parse(snapshotMessage));

const checkpoint = decodeServerCheckpoint(
  Board,
  JSON.parse(savedCheckpoint)
);
const restoredServer = createServer(Board, { checkpoint });
```

The decoders strictly validate batches, commits, snapshots, server checkpoints, schema paths, collection kinds, IDs, ranges, and JSON-compatible values. Their outputs are library-owned and deeply frozen. Generic `Value<T>` and `List<T>` payload shapes are only checked as JSON because TypeScript's `T` is unavailable at runtime; application-specific payload validation remains the caller's responsibility and typically belongs in the server resolver for incoming batches. The transport remains responsible for parsing JSON and enforcing message-size or rate limits.

`server.snapshot()` returns the current authoritative values together with the latest `serverSeq`. A new client using the same `DocumentSchema` can hydrate from that snapshot and then expects the following commit. Snapshots do not include a schema ID or version, and Articula does not provide schema migration. A real transport must obtain the snapshot and subscribe to later commits without leaving a gap; Articula does not retain commit history or manage connected clients. Snapshot containers are frozen, while nested JSON values follow the same immutable-value contract as `Value<T>`.

`server.checkpoint()` saves the authoritative snapshot and a `replays` array containing each known client's last `{ batch, commit }`. Passing it to `createServer()` restores the state, sequences, and saved retry results. Resolver callbacks are application code and must be supplied again; replay uses the saved result even if the restored resolver changes. Containers are frozen and nested JSON payloads retain the immutable-value contract. The previous `lastClientBatches` checkpoint shape is no longer accepted.

If checkpoints are persisted, save one before sending the corresponding new commit; a failed save must not continue using the advanced in-memory server. After a crash between saving and sending, the source can retry its saved batch to recover the original commit. Other peers that missed that commit still need a future catch-up mechanism; these per-client replay entries are not a global commit history.

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
- Articulated-backed `List<T>` collections
- Articulated-backed Unicode code-point `Text` collections
- Optimistic local mutations
- Explicit transaction batching
- Document-level change subscriptions
- Ordered authoritative server commits
- Local acknowledgement and pending-operation replay
- Rejected or server-transformed operations
- Synchronous server runtime with batch-level accept, reject, and transform policies
- Strict wire decoding for batches, commits, and snapshots
- Snapshot hydration for new clients
- Late join from the current authoritative state
- Server checkpoint and restore
- Last-batch retry deduplication and replay, including after restore

Not implemented yet:

- Transports, retry scheduling, commit catch-up, or reconnects
- Bulk list operations, move, public stable positions, cursors, or rich text
- Persistence, presence, or undo history
