# Articula

Articula is a small TypeScript library for building server-authoritative collaborative collections on top of [articulated](https://github.com/mweidner037/articulated).

The project is intentionally early and minimal. It provides a typed document schema, optimistic values, lists, and plain text, explicit transactions, client-side reconciliation, snapshot hydration, and a synchronous authoritative server runtime with batch policies. Production transports are planned next.

## Example

```ts
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

The decoders strictly validate batches, commits, snapshots, client and server checkpoints, schema paths, collection kinds, IDs, ranges, and JSON-compatible values. Their outputs are library-owned and deeply frozen. Generic `Value<T>` and `List<T>` payload shapes are only checked as JSON because TypeScript's `T` is unavailable at runtime; application-specific payload validation remains the caller's responsibility and typically belongs in the server resolver for incoming batches. The transport remains responsible for parsing JSON and enforcing message-size or rate limits.

`server.snapshot()` returns the current authoritative values together with the latest `serverSeq`. A new client using the same `DocumentSchema` can hydrate from that snapshot and then expects the following commit. Snapshots do not include a schema ID or version, and Articula does not provide schema migration. A real transport must obtain the snapshot and subscribe to later commits without leaving a gap; Articula does not manage connected clients. Snapshot containers are frozen, while nested JSON values follow the same immutable-value contract as `Value<T>`.

The server retains a bounded, consecutive commit history. `historyLimit` defaults to `1000`, must be a non-negative safe integer, and counts commits rather than payload bytes; `0` disables history. Accepted, rejected, and transformed batches all enter history, while retries do not. Use the client's last successfully received watermark to catch up:

```ts
const commits = server.commitsSince(lastReceivedServerSeq);
if (commits === null) {
  // The retained history cannot fill this gap; recover separately.
} else {
  for (const commit of commits) {
    doc.receive(commit);
    lastReceivedServerSeq = commit.serverSeq;
  }
}
```

`commitsSince()` returns a frozen array in global sequence order, an empty array when already caught up, or `null` when a complete catch-up is unavailable. Invalid or future watermarks throw. The caller records the watermark and coordinates catch-up with live subscription so no commit is skipped or delivered twice. If catch-up includes a saved retry commit, do not deliver that replay again. A client with pending mutations cannot simply switch to a fresh snapshot without risking lost operations; client checkpoints can preserve pending work, but automatic resume and recovery beyond retained history are not implemented.

`server.checkpoint()` saves the authoritative snapshot, a `replays` array containing each known client's last `{ batch, commit }`, and the retained `history`. Passing it to `createServer()` restores the state, sequences, saved retry results, and history. The full checkpoint is validated before history is trimmed to the current `historyLimit`; that option is not serialized, and increasing it cannot recover evicted commits. Empty history is valid even at a nonzero watermark. Resolver callbacks are application code and must be supplied again; replay uses the saved result even if the restored resolver changes. Containers are frozen and nested JSON payloads retain the immutable-value contract. Older checkpoints without `history` are no longer accepted.

If checkpoints are persisted, save one before sending the corresponding new commit; a failed save must not continue using the advanced in-memory server. After a crash between saving and sending, the source can retry its saved batch to recover the original commit, and peers can catch up while the required history remains available. History eviction does not affect each client's last-batch retry cache.

## Client checkpoint and restore

`doc.checkpoint()` saves the authoritative snapshot, the last emitted local batch sequence, pending batches, and List/Text bunch allocation counters. It does not save the optimistic view separately: restore rebuilds that view by replaying pending batches. Checkpointing inside a transaction throws.

After stopping the original writer, save and restore a client using the same schema and client ID:

```ts
const savedClientCheckpoint = JSON.stringify(doc.checkpoint());
const clientCheckpoint = decodeClientCheckpoint(
  Board,
  JSON.parse(savedClientCheckpoint)
);
const restoredDoc = createClient(Board, {
  clientId: clientCheckpoint.clientId,
  checkpoint: clientCheckpoint,
  onBatch: send,
});

const missed = server.commitsSince(clientCheckpoint.snapshot.serverSeq);
if (missed === null) {
  // Preserve this client and its pending work; recover separately.
} else {
  for (const commit of missed) restoredDoc.receive(commit);
  clients.set(clientCheckpoint.clientId, restoredDoc);
}
```

Restore does not emit changes or resend pending batches. `snapshot` and `checkpoint` options are mutually exclusive. Existing pending IDs are preserved; future List/Text IDs use a fresh generator starting after the saved allocation counters. Counters are not rolled back when a transaction fails or a batch is rejected. Sequence and ID allocation exhaustion throws before changing visible state; valid no-op text edits remain allowed.

There must be only one active writer for a client ID. Do not keep the old writer running, fork a checkpoint into multiple writers, or resume an older checkpoint that omits batches that may already have been sent. A fresh snapshot is for a new client with a new ID, not a replacement for pending work. Callers coordinate catch-up with live delivery, avoid duplicate commits, and decide whether to retry the last unresolved batch; there is no automatic resend or snapshot fallback.

For durable recovery, persist the checkpoint before sending a batch from `onBatch`, and again after successfully receiving commits. An own acknowledgement may emit no change, so a change listener alone cannot reliably trigger persistence. Runtime checkpoint containers are frozen and nested JSON payloads retain the immutable-value contract; decoding and restore deeply copy and freeze input. Callbacks, listeners, timers, storage, and transports are not serialized or provided.

## In-memory resume example

Run the synchronous example directly:

```sh
node examples/resume.ts
```

It demonstrates a lost acknowledgement, unsent mixed Value/List/Text mutations, checkpoint JSON decoding, catch-up, and a subsequent live edit. The same example-only helper is used by the end-to-end tests:

```ts
import { Board, createExampleNetwork } from "./examples/resume.ts";

const network = createExampleNetwork(createServer(Board));
// Stop the original writer before restoring its client ID.
const connection = network.connect(clientCheckpoint.clientId, clientCheckpoint);
if (!connection.resume()) {
  // Preserve connection.doc.checkpoint(); retained history cannot fill this gap.
}
```

Without a checkpoint, `connect(clientId)` starts live from the server snapshot. With a checkpoint, it starts disconnected and does not resend anything. `disconnect()` stops incoming and outgoing delivery; local mutations remain in the document's pending batches.

`resume()` first checks whether the server can fill the document's watermark gap. If not, it returns `false`, leaves the connection disconnected, and neither submits pending work nor replaces the snapshot. Otherwise it enables incoming delivery, applies the entire catch-up in one queue job, and repeatedly reads the **current** checkpoint's earliest pending batch, submitting and completing delivery before selecting the next one. An accepted batch whose acknowledgement was lost is removed during catch-up rather than submitted again. Own acknowledgements need not emit a change for this loop to continue.

Listeners may create new mutations during recovery. The recovering document buffers them behind its existing pending batches; mutations from live peers enter the FIFO queue. Each new commit finishes delivery to all recipients before the next queued batch is processed. Retry receipts go only to the source, and already-consumed server sequences are skipped. After pending work and queued delivery are drained, the connection becomes live.

Call `resume()` only while the queue is idle; reentrant calls throw. Resolver, receive, or listener errors during queued processing stop the network and propagate to the caller. Do not reuse that failed network. Connection handles still expose their documents so their latest checkpoints can be saved; completed commits are not rolled back, and unacknowledged work remains pending.

This is an example-layer resume workflow, not a package API or production reconnect implementation. Its exports are only for the example and tests. It assumes one stopped old writer per client ID, finite listener-generated edits, and synchronous single-process routing. The queue provides the catch-up/live handoff only within that process; it does not solve a subscription race across a real network. Storage, async transport, retry scheduling, recovery beyond retained history, and automatic repair of pending operations invalidated by rejection or transformation remain the caller's responsibility.

## Asynchronous JSON/resume example

```sh
node examples/async-resume.ts
```

This second example uses independent FIFO Promise chains. The server orders batches without waiting for clients to receive commits, and each client receives commits in order. Its fixed `Board` schema is shared with the synchronous example; neither helper is part of the package API.

```ts
import { createServer } from "./src/index.ts";
import { Board } from "./examples/resume.ts";
import { createAsyncExampleNetwork } from "./examples/async-resume.ts";

const network = createAsyncExampleNetwork(createServer(Board));
const connection = network.connect("client-a");
connection.doc.state.count.value = 1; // Optimistic state changes immediately.
await network.idle(); // Includes acknowledgement delivery and listener-created work.

connection.disconnect();
connection.doc.state.items.push("Offline");
if (!(await connection.resume())) {
  // Preserve connection.doc.checkpoint(); retained history cannot fill this gap.
}
await network.idle();
```

Batch and commit messages are serialized before delivery, asynchronously transferred, parsed, and passed through `decodeClientBatch()` or `decodeServerCommit()` before application. The optional `transfer(direction, clientId, message): Promise<string>` hook defaults to returning the message asynchronously. Tests use manually released Promise gates to delay or corrupt messages without timers or real network traffic. Directions are `"client-to-server"` and `"server-to-client"`.

Each live client has at most one outbound pump. It selects the earliest **current** pending batch, waits for its own commit to be applied, and then rereads pending work. Editing can continue while an acknowledgement is delayed. A slow sender or recipient does not block other clients. New commits go to subscribed clients; replay receipts go only to their source, with already-consumed sequences skipped.

`connect(clientId, checkpoint?)` is synchronous and requires the network to be idle. Without a checkpoint it creates a live client from a JSON-decoded snapshot; with one it restores a disconnected client. Initial snapshot creation is in-process, not an asynchronous network handshake. `disconnect()` stops subsequent sends and incoming application, but an already-started request may still reach the server. Await `network.idle()` after disconnecting before replacing the stopped writer with its latest checkpoint.

`resume(): Promise<boolean>` also requires idle at entry. It buffers local edits while the server atomically obtains catch-up, queues the entire prefix, and enables subscription. That server job contains no delivery awaits: peers may generate new commits while catch-up delivery is paused, but those commits queue after the prefix in the recovering client's inbox. Resume drains the latest pending work and queued incoming updates before switching live. Insufficient history returns `false` without submitting or replacing pending work. Reentrant resume and disconnect during recovery are rejected.

`network.submit(batch): Promise<void>` is an example/test helper for manually submitting offline work. Completion means the server has processed the batch and scheduled delivery, not that the sender has received its acknowledgement. Use `idle()` to wait for all tracked server work, incoming delivery, pumps, and recovery, including work added while waiting. Do not await `idle()` from inside a listener.

Transfer, parsing, decoding, resolver, receive, or incoming-listener failures stop the whole network and retain the first error. Waiting operations reject even if another transfer is still paused; queued and late-completing work must not continue applying updates. Background jobs have rejection observers. Completed commits are not rolled back, and handles retain their documents for checkpoint recovery. Do not reuse a failed network.

This remains a single-process demonstration, not production transport or reconnect. It assumes one stopped old writer per client ID, FIFO delivery, and synchronous listeners producing finite edits. It provides no persistence, timeouts, cancellation of external transfer-hook side effects, unordered delivery repair, retry scheduling, or automatic repair of pending references invalidated by rejection or transformation.

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
- Client checkpoint and restore with pending-operation replay
- Example-only synchronous resume with catch-up, pending resubmission, and live routing
- Example-only asynchronous JSON resume with independent FIFO delivery
- Last-batch retry deduplication and replay, including after restore
- Bounded global commit catch-up, including after restore

Not implemented yet:

- Transports, retry scheduling, automatic client resume, or reconnects
- Bulk list operations, move, public stable positions, cursors, or rich text
- Persistence, presence, or undo history
