# Articollab

Articollab is a small TypeScript library for building server-authoritative collaborative collections on top of [articulated](https://github.com/mweidner037/articulated).

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
} from "articollab";

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

The client keeps local batches pending until their matching server commits arrive. On each commit, it updates its authoritative state, removes the acknowledged local batch when applicable, then replays the remaining pending batches. A commit with no operations rolls back the matching optimistic batch. Commits must arrive exactly once, starting at `serverSeq: 1`, and `receive()` must not be called inside `transact()`. If pending replay encounters a state conflict, the valid commit still advances the client; the failed batch and its suffix stay pending, as described below.

The server assigns new batches a total order synchronously, in the order of `server.receive(batch)` or `server.reject(batch)` calls that return `replayed: false`. An optional batch-level `resolve` callback receives a frozen owned batch and the authoritative snapshot from immediately before that batch. Returning the original operations accepts it, returning different operations transforms it, and returning an empty array rejects its authoritative effect while still acknowledging the batch. A resolver should be a pure synchronous decision: throwing, returning a non-array, producing an invalid operation, or calling the same server's `receive()` or `reject()` reentrantly aborts without consuming sequence numbers. When reusing an incoming text insertion ID, a resolver should preserve its code-point length; a different-length or server-created insertion requires an application-supplied globally unique ID range that cannot collide with client pending IDs.

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

`server.snapshot()` returns the current authoritative values together with the latest `serverSeq`. A new client using the same `DocumentSchema` can hydrate from that snapshot and then expects the following commit. Snapshots do not include a schema ID or version, and Articollab does not provide schema migration. A real transport must obtain the snapshot and subscribe to later commits without leaving a gap; Articollab does not manage connected clients. Snapshot containers are frozen, while nested JSON values follow the same immutable-value contract as `Value<T>`.

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

## Pending replay conflicts

Rejection or transformation can invalidate later local operations. For example, batch 1 inserts A, batch 2 inserts B after A, and the server rejects batch 1: batch 2 now references an unknown anchor. The client accepts the valid commit and records a frozen, read-only `doc.replayConflict` rather than throwing or silently dropping batch 2:

```ts
doc.on("change", () => {
  const conflict = doc.replayConflict;
  if (conflict !== null) {
    console.log(conflict.batch.seq, conflict.operationIndex, conflict.message);
    // Preserve doc.checkpoint(); do not change or discard the pending batch.
  }
});
```

`replayConflict` is `null` when every pending batch can be replayed. Otherwise it identifies the first failed batch and its zero-based operation index; `message` is diagnostic text, not a stable error code. The visible document is authoritative state plus the complete replayable pending prefix. A failed mixed transaction contributes no partial Value/List/Text changes, and later batches are not replayed. Original pending batches, local sequences and ID allocations remain intact.

While blocked, reads, subscriptions, checkpointing and incoming commits remain available. Actual local mutations throw before changing state or allocating sequences/IDs, and `transact()` throws before invoking its callback. Valid empty Text insertions and zero-count deletions remain no-ops. Each later commit retries replay from authoritative state, so the conflict can change or clear. Document-level server `change` fires once when visible values or the conflict descriptor change, including a conflict-only transition; identical conflicts do not emit solely because the watermark advanced. An ordinary own acknowledgement remains silent when neither changes.

Only state-dependent List/Text errors (unknown anchors/targets or insertion ID collisions) become replay conflicts. Invalid server operations, sequence errors, wrong acknowledgements and unexpected replay errors still throw atomically. Listener exceptions occur after a successful receive has committed, as before. There is no automatic rebase, client-side pending purge or ID remapping. A blocked client may stay blocked until application-driven server commits resolve the pending dependencies or acknowledge those batches. Do not edit a previously submitted batch, skip its sequence or replace pending work with a fresh snapshot.

## Explicit server rejection and manual recovery

A trusted server application can explicitly reject an original batch:

```ts
const { commit, replayed } = server.reject(batch);
// Deliver a new commit normally; route a replay only to its waiting source.
```

For a new sequence-valid batch, `reject()` skips the resolver and does not apply incoming operations. It creates a frozen empty-operations commit, advances client/global sequences, and records the original owned batch in the retry cache and the commit in history. Authoritative values and tombstones do not change. State-dependent unknown anchors/targets or insertion ID collisions therefore do not prevent explicit rejection. As with `receive()`, input must come from the same-schema client or `decodeClientBatch()`; this typed API is not a wire decoder or an authorization boundary.

Rejection is not undo. If the last batch was already processed, both `receive()` and `reject()` replay its original result, even if it was accepted or transformed. Changing the batch payload, retrying an older batch or skipping a client sequence still throws. The original batch must be preserved; sending an empty client batch or deleting pending locally is not cancellation.

Run the manual recovery example:

```sh
node examples/reject-pending.ts
```

Its example-only `rejectPending(server, doc)` captures the initial `lastLocalSeq`, then applies the complete catch-up before rejecting any remaining pending batches up to that cutoff. It re-reads the earliest pending after each acknowledgement, so it neither resubmits already-confirmed work nor relies on change events for silent acknowledgements. Returning `true` means the targeted batches are confirmed, not that all later pending work is empty: listener-created higher-sequence edits remain pending. New edits may depend on a cancelled insertion and become blocked themselves; inspect `doc.replayConflict` again rather than assuming recovery made every suffix replayable. The explicit action cancels the whole original pending range, including mutations that were still replayable, rather than only the failing operation.

If retained history is insufficient, it returns `false` without rejecting anything or replacing the document. Exceptions propagate; completed commits are not rolled back and the latest checkpoint retains unconfirmed work. Recovery cannot run concurrently or reentrantly for the same server or document. The example uses manual submission with no other server writes interleaving, no background pump and no transport queue; peers catch up separately. A production caller must coordinate submission, persistence, commit delivery and authorization. No helper automatically requests cancellation. The HTTP helper offers an explicit action as described below; the package client API and wire formats remain unchanged.

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

Checkpoint shape is unchanged: conflict is derived again from snapshot and pending during restore, producing the same complete optimistic prefix. The decoder accepts structurally valid pending work that currently conflicts with authoritative state, including unknown references and snapshot ID collisions. It still validates every pending batch, even after the first conflict: fields, JSON, schema kinds, sequence suffix, canonical client/path insert namespaces and allocation counters. Pending insertion ID ranges must not overlap each other. Malformed checkpoints remain errors; accepting a blocked checkpoint does not mean its pending operations can be submitted safely.

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
  // Preserve connection.doc.checkpoint(); inspect replayConflict or handle a history gap.
}
```

Without a checkpoint, `connect(clientId)` starts live from the server snapshot. With a checkpoint, it starts disconnected and does not resend anything. `disconnect()` stops incoming and outgoing delivery; local mutations remain in the document's pending batches.

`resume()` first checks whether the server can fill the document's watermark gap. If not, it returns `false`, leaves the connection disconnected, and neither submits pending work nor replaces the snapshot. Otherwise it enables incoming delivery, applies the entire catch-up in one queue job, and repeatedly reads the **current** checkpoint's earliest pending batch, submitting and completing delivery before selecting the next one. After the complete catch-up, and before each submission, a remaining `replayConflict` returns `false` and leaves recovery offline without discarding pending work. A later resume can try catch-up again. Temporary conflicts within the prefix do not interrupt it: a later own commit may clear them. An accepted batch whose acknowledgement was lost is removed during catch-up rather than submitted again. Own acknowledgements need not emit a change for this loop to continue.

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
  // Preserve connection.doc.checkpoint(); inspect replayConflict or handle a history gap.
}
await network.idle();
```

Batch and commit messages are serialized before delivery, asynchronously transferred, parsed, and passed through `decodeClientBatch()` or `decodeServerCommit()` before application. The optional `transfer(direction, clientId, message): Promise<string>` hook defaults to returning the message asynchronously. Tests use manually released Promise gates to delay or corrupt messages without timers or real network traffic. Directions are `"client-to-server"` and `"server-to-client"`.

Each live client has at most one outbound pump. It selects the earliest **current** pending batch, waits for its own commit to be applied, and then rereads pending work. Editing can continue while an acknowledgement is delayed unless replay is blocked. A slow sender or recipient does not block other clients. New commits go to subscribed clients; replay receipts go only to their source, with already-consumed sequences skipped.

Both in-memory networks pause automatic outbound work while blocked, but keep incoming delivery active for live clients and leave peers usable. Queued sends recheck current pending state before server application. A subsequent incoming commit that clears the conflict restarts live pumping. Explicit `submit(batch)` remains an application/test action, not automatic conflict repair. Already-accepted work cannot be recalled.

`connect(clientId, checkpoint?)` is synchronous and requires the network to be idle. Without a checkpoint it creates a live client from a JSON-decoded snapshot; with one it restores a disconnected client. Initial snapshot creation is in-process, not an asynchronous network handshake. `disconnect()` stops subsequent sends and incoming application, but an already-started request may still reach the server. Await `network.idle()` after disconnecting before replacing the stopped writer with its latest checkpoint.

`resume(): Promise<boolean>` also requires idle at entry. It buffers local edits while the server atomically obtains catch-up, queues the entire prefix, and enables subscription. That server job contains no delivery awaits: peers may generate new commits while catch-up delivery is paused, but those commits queue after the prefix in the recovering client's inbox. Resume drains queued incoming updates before checking for blocked replay and submitting the latest pending work. Insufficient history or a remaining replay conflict returns `false` and leaves recovery offline without submitting or replacing pending work; conflict is not network failure and a later resume can try again. Reentrant resume and disconnect during recovery are rejected.

`network.submit(batch): Promise<void>` is an example/test helper for manually submitting offline work. Completion means the server has processed the batch and scheduled delivery, not that the sender has received its acknowledgement. Use `idle()` to wait for all tracked server work, incoming delivery, pumps, and recovery, including work added while waiting. Do not await `idle()` from inside a listener.

Transfer, parsing, decoding, resolver, receive, or incoming-listener failures stop the whole network and retain the first error. Waiting operations reject even if another transfer is still paused; queued and late-completing work must not continue applying updates. Background jobs have rejection observers. Completed commits are not rolled back, and handles retain their documents for checkpoint recovery. Do not reuse a failed network.

This remains a single-process demonstration, not production transport or reconnect. It assumes one stopped old writer per client ID, FIFO delivery, and synchronous listeners producing finite edits. Storage is supplied by the caller, as in the file-backed example below. There are no timeouts, cancellation of external transfer-hook side effects, unordered delivery repair, retry scheduling, or automatic repair of pending references invalidated by rejection or transformation.

## File-backed checkpoint recovery example

```sh
node examples/persistent-resume.ts
```

This example adds synchronous JSON storage to the same asynchronous network helper, without changing the package runtime. It saves mixed offline work, accepts a batch without acknowledging its disconnected source, then rebuilds the server and clients from files, resumes, and makes a live edit. It uses and cleans up its own temporary directory; importing it does not run the demo.

```ts
import { createServer } from "./src/index.ts";
import { Board } from "./examples/resume.ts";
import { createAsyncExampleNetwork } from "./examples/async-resume.ts";
import { createCheckpointStore } from "./examples/persistent-resume.ts";

const store = createCheckpointStore(existingDirectory);
const savedServer = store.loadServer();
const server = createServer(Board, {
  ...(savedServer === null ? {} : { checkpoint: savedServer }),
  resolve: ({ batch }) => batch.operations, // Supply application policy again.
});
store.saveServer(server.checkpoint()); // Finish bootstrap before accepting clients.
const network = createAsyncExampleNetwork(server, {
  saveClientCheckpoint: store.saveClient,
  saveServerCheckpoint: store.saveServer,
});
const savedClient = store.loadClient("client-a");
const connection = network.connect("client-a", savedClient ?? undefined);
if (savedClient !== null && !(await connection.resume())) {
  // Keep the saved pending work; inspect replayConflict or handle a history gap.
}
await network.idle();
```

The example-only `createCheckpointStore(directory)` requires an existing directory. It provides `loadServer()`, `saveServer(checkpoint)`, `loadClient(clientId)`, and `saveClient(checkpoint)`. Loads read only official files, parse JSON, and use the existing checkpoint decoders; only a missing file returns `null`. Corrupt JSON, invalid checkpoints, mismatched client IDs, and other filesystem errors throw rather than silently starting fresh. Use a new client ID for a genuinely new client; a missing client file is not permission to reset an existing writer or discard its pending work.

The asynchronous helper accepts optional `saveClientCheckpoint` and `saveServerCheckpoint` callbacks. They synchronously return `undefined`, so an async callback fails type checking. They are trusted application code: save only, without reentering the network or mutating documents. When omitted, the helper behaves as before.

Saving happens at these boundaries:

- Connect saves the initial or restored client before registering it.
- Every local batch saves the complete current client checkpoint before starting a send, including offline and recovery edits.
- Successful incoming application saves the latest client checkpoint, even for a silent own acknowledgement. Already-consumed commits are skipped.
- Each new server result is saved before any delivery is queued, including rejection and transformation. A replay receipt does not save the server again.

Local state changes optimistically before saving, and a save failure may throw from the mutation itself; the batch and visible state are not rolled back. Saving failures stop the network and reject waiting operations. Do not reuse an advanced in-memory server after its save fails: rebuild from the last successfully saved files. If an incoming listener throws, preserve that error and do not attempt an extra save that could mask it. Only successfully saved work is promised recoverable.

Files are `server.json` and `client-<hex>.json`, where `<hex>` is the lowercase hex encoding of the client ID's UTF-16LE bytes. For example, `a` uses `client-6100.json` and `A` uses `client-4100.json`. This lossless encoding avoids case and Unicode-normalization collisions on local filesystems. Each save serializes completely, writes a same-directory `<target>.tmp` file, then renames it over the official file; newly created files use mode `0o600`. Orphan temporary files are ignored on load. Writes block the event loop and require one writer per file in a trusted local directory. This verifies process interruption and restart, not power-loss durability: there is no fsync/directory-sync protocol, cross-file transaction, lock, migration, production storage adapter, or recovery beyond retained history.

## Localhost HTTP sync example

```sh
node examples/http-sync.ts
```

This example uses real localhost HTTP requests with Node's built-in HTTP server and fetch. It demonstrates two clients making mixed optimistic edits, restoring a checkpoint after a lost POST response, and manually syncing to convergence. Importing it does not run the demo or open a socket. The helpers are example-only and are not package exports.

```ts
import { createServer } from "./src/index.ts";
import { Board } from "./examples/resume.ts";
import { startHttpExampleServer, connectHttpExampleClient } from "./examples/http-sync.ts";

const host = await startHttpExampleServer(createServer(Board));
try {
  const client = await connectHttpExampleClient(host.url, "client-a");
  client.doc.state.items.push("Saved"); // Optimistic and pending; no automatic send.
  if (!(await client.sync())) {
    // Preserve client.doc.checkpoint(); inspect replayConflict or handle a history gap.
  }
} finally {
  await host.close();
}
```

The host listens only on `127.0.0.1`, using an automatically assigned port. Its endpoints are:

| Endpoint | Successful response |
| --- | --- |
| `GET /snapshot` | `200`: the current document snapshot |
| `POST /batches` | `204`: no body, including for a valid retry |
| `POST /rejections` | `204`: no body, including for a valid retry; the original batch is passed to `server.reject()` |
| `GET /commits?since=N` | `200`: the complete later commit array, or JSON `null` when history is insufficient |

Both POST routes require `application/json` and at most 1 MiB of actual UTF-8 bytes, including chunked bodies. JSON and wire validation use the existing decoder before runtime handling. Invalid JSON/wire/watermarks return `400`; runtime receive/reject failures return `409` without distinguishing their causes. Oversized bodies return `413`, unsupported content types `415`, unknown routes `404`, incorrect methods `405`, and unexpected handler errors `500`. Error bodies contain only `{ error: string }`, not stack traces. The server's total order is synchronous `receive()`/`reject()` call order after reading each body, not initial HTTP request arrival. There is no subscription registry or broadcast. Neither POST route authenticates or authorizes callers: `clientId` is not proof of identity, and the host is only for trusted localhost use.

`connectHttpExampleClient(url, clientId, options?)` fetches and decodes a snapshot for a fresh client. With `options.checkpoint`, it instead restores the complete client checkpoint using the existing runtime validation, without making any HTTP requests or automatically submitting pending work. The checkpoint must match `clientId`. Its optional `fetch` override is for controlling requests in tests; by default it uses native fetch. The client knows only the URL, not the server object. Updates after the snapshot or checkpoint watermark are caught by the first sync.

`sync(): Promise<boolean>` first fetches catch-up from the latest checkpoint watermark, validates and applies the whole ordered prefix, then posts the earliest current pending batch. It fetches catch-up again to acknowledge that batch before rereading pending work. Listener-created mutations wait behind earlier batches; silent acknowledgements do not depend on change events. POST success alone never applies a commit: an own result at sequence 12 must not bypass missing sequence 11. A successful submission without a subsequent catch-up acknowledgement throws instead of looping.

If the full catch-up leaves `doc.replayConflict` non-null, sync returns `false` without posting pending work, including any replayable prefix. This is not permanent connection failure: later calls still poll for commits that may unblock replay. A conflict that appears and clears within one catch-up response does not stop sync. Saving hooks persist successfully applied commits and blocked checkpoints as usual. Check `replayConflict` when handling `false`; history gaps and actual failures retain the distinct behavior below.

`true` means the latest fetched prefix was applied and pending work is empty at that moment, not that later remote edits cannot occur. Peers need their own explicit sync. `sync()` and `rejectPending()` share one concurrent/reentrant guard: a competing call rejects without stopping the active operation. Insufficient history returns `false` permanently for that connection, with no further requests or snapshot replacement; pending work and the document remain available. Fetch, HTTP, JSON, decoder, receive, or incoming-listener failures stop only the affected connection and preserve its first error for subsequent calls. Completed updates are not rolled back. If a POST response is lost, the server may already have processed the batch while the client still has it pending; this example does not automatically retry or reconnect.

### Explicit HTTP pending cancellation

```sh
node examples/http-reject-pending.ts
```

The demo shows a policy rejection invalidating later mixed List/Text edits, explicit cancellation, peer catch-up and subsequent editing. It reuses the same HTTP helpers; importing it does not run the demo or open a socket.

```ts
if (!(await client.sync()) && client.doc.replayConflict !== null) {
  // Explicitly abandon all batches pending when this action starts, not just the conflict.
  const confirmed = await client.rejectPending();
  // false: history is insufficient; preserve the checkpoint instead of replacing the snapshot.
  // true: the original targets are confirmed; inspect remaining pending/conflict before syncing.
}
```

`rejectPending(): Promise<boolean>` captures `lastLocalSeq` before its first await and applies the complete catch-up before posting any original pending batch to `/rejections`. It then re-reads the earliest pending after each POST and ordered catch-up acknowledgement, even while blocked. POST success is not an ack, and missing acknowledgement throws rather than looping. Batches accepted or transformed before cancellation are confirmed without undoing their authoritative effects. Across both POST routes, a valid latest-batch retry always preserves the first processed result.

Returning `true` means every targeted batch has been confirmed, not that pending is empty or replay is unblocked. Listener-created higher-sequence batches remain pending and are not submitted automatically; they can themselves depend on cancelled IDs and become blocked. No automatic cancellation, pending purge or rebase occurs. History gaps and errors follow the same connection-stop rules as sync. After a lost rejection response, wait for the operation to settle, retire the old writer, restore a new connection from its checkpoint and catch up before deciding whether to cancel the remaining work. Cancellation scope is not stored as a durable intent: calling `rejectPending()` again captures a new cutoff.

To manually reconnect, retire the old writer and restore a new connection from its latest complete checkpoint. Wait for any active sync to settle before taking the checkpoint; this helper does not cancel requests or prevent two independent writers from using the same client ID. For parsed JSON, use the existing decoder:

```ts
import { decodeClientCheckpoint } from "./src/index.ts";

// The old sync has failed or finished, and the old writer will make no more edits.
const checkpoint = decodeClientCheckpoint(
  Board,
  JSON.parse(JSON.stringify(client.doc.checkpoint()))
);
const restored = await connectHttpExampleClient(host.url, "client-a", { checkpoint });
// Optimistic state and pending edits are already restored, but nothing has been sent.
if (!(await restored.sync())) {
  // Preserve restored.doc.checkpoint(); do not discard pending with a fresh snapshot.
}
```

If batch 1 was accepted but its POST response was lost, and batch 2 was never submitted, the first catch-up confirms batch 1 and only batch 2 is posted. The resolver does not run again for the confirmed batch. Pending batches, local batch sequences, and List/Text ID allocation progress survive restore; new edits, including listener-created edits during sync, remain behind older pending work. Silent own acknowledgements still advance submission. A failed old connection remains stopped; a restored connection has its own failure state and follows the same stop-on-error rules. History gaps still return `false` permanently without submitting pending or replacing the snapshot.

The server must represent the same document lineage and retain the required history and retry metadata. A server restored from its existing checkpoint can run at a new URL, but this example does not detect server identity/epoch changes or recover from server rollback. Restoring a client checkpoint is not a substitute for retained history; reject/transform results that make later pending operations impossible to replay preserve blocked pending work rather than repairing it.

This is a Node-only, single-document localhost demonstration with one writer per client ID and synchronous listeners producing finite edits. Reconnect is caller-initiated reconstruction, not automatic retry. It does not provide authentication, TLS, CORS, WebSocket/SSE, automatic polling, retry timers, request abortion, history pagination, snapshot fallback, or production transport guarantees. Tests include a separate client process restoring a JSON checkpoint and talking to the parent server through HTTP. Optional synchronous saving callbacks integrate file storage as shown below.

## File-backed HTTP recovery example

```sh
node examples/persistent-http-sync.ts
```

This demo combines the existing JSON checkpoint store with real localhost HTTP. It saves mixed optimistic edits, loses a POST response after the server has saved its result, closes the old host, and rebuilds server and clients from the official files. Manual sync confirms the accepted batch through catch-up and submits only remaining pending work, then demonstrates subsequent edits and convergence. Importing the demo has no side effects; direct execution owns and cleans up its temporary directory and hosts.

The saving callbacks are example-only options, not package APIs. They must return synchronously (`undefined`, not a Promise), only save their argument, and never reenter the helpers or mutate documents:

```ts
import { createServer } from "./src/index.ts";
import { Board } from "./examples/resume.ts";
import { createCheckpointStore } from "./examples/persistent-resume.ts";
import { startHttpExampleServer, connectHttpExampleClient } from "./examples/http-sync.ts";

const store = createCheckpointStore(directory); // Caller supplies an existing trusted directory.
const savedServer = store.loadServer();
const server = createServer(Board, {
  ...(savedServer === null ? {} : { checkpoint: savedServer }),
  resolve: ({ batch }) => batch.operations, // Application policy must be supplied again.
});
const host = await startHttpExampleServer(server, { saveServerCheckpoint: store.saveServer });
try {
  const savedClient = store.loadClient("client-a");
  const client = await connectHttpExampleClient(host.url, "client-a", {
    ...(savedClient === null ? {} : { checkpoint: savedClient }),
    saveClientCheckpoint: store.saveClient,
  });
  client.doc.state.items.push("Saved before sending");
  if (!(await client.sync())) {
    // Retain the saved pending state; inspect replayConflict or handle a history gap.
  }
} finally {
  await host.close();
}
```

Saving order is deliberate:

- The server saves its initial checkpoint before listening. After each new `receive()` or `reject()`, including policy reject/transform, it saves before sending `204`. Valid retries do not save again. Runtime handling, save, and response contain no intervening await, so another request cannot observe a result before saving finishes.
- Fresh and restored clients save once before returning a handle. Every local batch saves after pending is added, without automatic sending. Each successfully received commit saves again, including silent own acknowledgements. Listener-created local mutations save the full current pending state.
- Without saving callbacks, the existing HTTP behavior is unchanged. The store uses synchronous temporary-write/rename and the existing decoders. Corrupt JSON, invalid checkpoints and filesystem errors throw, rather than silently starting fresh.

A client save failure permanently stops that connection and preserves its first error. Connect rejects on initial failure; a local mutation can throw after its optimistic state and pending have already changed. An active sync stops at its next checked asynchronous boundary, without applying further commits or sending subsequent batches. Responses are still consumed, but already-sent requests cannot be recalled: the server may have accepted them. Incoming listener failure does not trigger an extra save that could hide its error. Only the last successfully saved client checkpoint is recoverable; unsaved edits are not claimed recoverable, and runtime changes are not rolled back.

A server save failure after receive returns `500` for that request and permanently disables the host. Subsequent requests, including bodies already being read, receive `503` instead of accessing advanced state. Ordinary resolver/runtime validation failures remain `409` and do not disable the host. The caller closes the disabled host and rebuilds from files; it must not reuse the advanced in-memory server. Error responses contain only generic `{ error: string }` messages.

Restore assumes the same document lineage, retained history/retry metadata, one writer per file/client ID, and retired old writers with settled sync calls. Client and server files are not a cross-file transaction. This example adds no async persistence, fsync/directory-sync protocol, locks, migration, snapshot fallback, automatic retry, or power-loss durability guarantee. Pending operations invalidated by policy remain explicitly blocked and are not automatically repaired. It is a process-interruption recovery example, not production persistence or transport.

## Browser core smoke example

```sh
pnpm build
node examples/browser-smoke/server.ts
```

Open the printed localhost URL in desktop Chrome. The page runs three fixed scenarios: optimistic mixed edits with delayed delivery, JSON checkpoint restore with tombstones and pending work, and explicit rejection followed by blocked recovery and resumed editing. Each scenario shows client watermarks, pending sequences, visible values and conflict state. A successful run reports `PASS: all 3 scenarios completed`; **Run again** uses fresh objects, and reloading runs the checks again. Module-loading or assertion failures appear on the page instead of being reported as success.

Both clients and the authoritative server run inside the page. The Node host only serves local assets: the production ESM build and the installed articulated/sparse-array-rled ESM builds. An import map resolves package names, while fixed extensionless asset aliases accommodate the dependencies' relative imports. No JavaScript is rewritten, and no CDN, bundler, Node polyfill or new dependency is used. The aliases are example-only loading support, not a package loader contract or a production browser transport. This smoke check validates desktop Chrome, not a complete browser compatibility matrix.

```sh
pnpm exec tsc --ignoreConfig --allowJs --checkJs --noEmit --strict --target ES2024 --module NodeNext --moduleResolution NodeNext examples/browser-smoke/smoke.js
node --unhandled-rejections=strict --test test/browser-smoke.test.ts
```

The focused native tests build production code once before importing the same smoke module, verify its repeatability and local asset routes, and check import side effects. Running them in Node does not replace opening the page in a real browser. The JavaScript smoke module uses JSDoc for type checking and browser-native execution; production `dist` still contains only library code.

## Browser HTTP smoke example

```sh
pnpm build
node examples/browser-http-smoke/server.ts
```

Open the printed localhost URL in desktop Chrome. Unlike the core smoke above, the authoritative server runs in Node; the two browser clients use native `fetch` for snapshots, batch submission, ordered commit catch-up and explicit rejection. The page and fixed ESM assets share the API's origin, so no CORS, CDN, bundler or Node polyfill is needed. Both Node and browser wrappers use the same example-only synchronization controller; their initialization remains separate so source-based Node tests do not require a production build.

Three fixed scenarios check mixed optimistic edits and silent acknowledgements, JSON checkpoint restore with tombstones and pending work, and rejection followed by blocked recovery and resumed editing. Each reports client/server state, watermarks, pending sequences and conflicts; failures stop the run and appear on the page. **Run again** and reload create new UUID client namespaces and start from the current server snapshot, not a reset document. The demo policy rejects only the first batch of each `reject-` client, then accepts later work. Assume no other writers while a smoke run is in progress.

```sh
node --unhandled-rejections=strict --test test/browser-http-smoke.test.ts
pnpm exec tsc --ignoreConfig --allowJs --checkJs --allowImportingTsExtensions --noEmit --strict --target ES2024 --module NodeNext --moduleResolution NodeNext examples/browser-smoke/smoke.js examples/http-sync-controller.js examples/browser-http-smoke/smoke.js
```

The focused Node tests run the same browser-compatible module with built ESM and real localhost HTTP, but do not replace checking all three scenarios, **Run again** and reload in Chrome. Synchronization is manual: there is no polling, automatic retry, browser storage or production reconnect. The host is unauthenticated, including `/rejections`; client IDs are namespaces, not authorization. Checkpoint restore is in memory, cancellation is not undo, and module/HTTP/decode/listener failures are not automatically repaired.

## Browser reload recovery example

```sh
pnpm build
node examples/browser-reload-recovery/server.ts
```

Open the printed URL in a browser and keep that server running. **Add offline mixed edit** saves a complete client checkpoint to sessionStorage without sending a batch. Reload the same tab: the original client identity, pending work, tombstones and allocation counters are restored without fetching a new snapshot or automatically syncing. **Sync** first catches up, then submits remaining pending batches. Deletions and later edits use the same sequence/ID progress.

To also recover after a server process interruption, pass an **existing directory** and an explicit fixed port:

```sh
node examples/browser-reload-recovery/server.ts /existing/checkpoint-directory 3000
```

Stop and restart using exactly the same directory and port, then reload the original tab and manually sync. The host restores `server.json`, including authoritative state, tombstones, retry results and retained commit history. Client checkpoints remain in sessionStorage, not server-side files. Keeping the port preserves the browser origin; the recovery envelope separately identifies the document, but neither coordinates writers. With no arguments the host remains in-memory with an automatically assigned port. Persistent CLI mode requires both arguments and a decimal port from 1 to 65535; occupied ports fail rather than silently changing the origin. Example-only host helpers additionally accept `port: 0` for initial automatic allocation; callers must reuse the returned port on restart.

This recovery example saves `{ documentId, checkpoint }` in both `server.json` and the existing sessionStorage key. `documentId` is a canonical lowercase UUID v4: a fresh host creates it once and a persistent restart keeps it. The ID and server checkpoint are replaced together in one file, not separate metadata files. The page displays the ID and complete client recovery envelope for export. Core checkpoint and wire formats are unchanged. The store's example-only `loadRecoveryServer()` / `saveRecoveryServer()` handle this envelope; the original `loadServer()` / `saveServer()` still handle raw checkpoints for other demos. Use separate directories for these incompatible example formats. Legacy raw recovery checkpoints, missing or invalid IDs, extra fields and corrupt data throw without migration, overwriting or fresh fallback; preserve old data separately rather than attaching it to a fresh document.

The recovery host enables the HTTP helper's optional `documentId` guard. API responses carry `X-Articollab-Document-Id`; a fresh client learns it from `/snapshot`, and requests to `/commits`, `/batches` and `/rejections` must carry the same ID. Missing or mismatched request IDs return `409` before history access, resolver execution or batch processing. The recovery client's injected fetch wrapper checks response identity before decoding, including `204` responses; missing, invalid or different IDs stop the connection and preserve pending and stored work. Restore still makes no initialization request: identity is verified on the next manual sync or cancellation. Other HTTP demos remain unguarded and unchanged. The shared synchronization controller is not duplicated or modified.

A fresh client has no expected ID: it trusts the first valid snapshot header as its initial identity. A different valid UUID substituted there cannot be identified at initialization; the next request to a correctly guarded host rejects the mismatch before pending submission. This is accidental-lineage protection, not protection against a malicious server or response rewriting.

Bootstrap loads and validates the checkpoint, saves it, then starts listening. Only a missing `server.json` creates a fresh server; malformed JSON, invalid checkpoints and filesystem errors stop startup without fresh fallback. Every new accepted or rejected batch is saved before HTTP success; retries do not write again. A server save failure returns an error and disables that host. Close it and build a new host from the last successfully saved file; the advanced in-memory state must not be reused. This uses the existing synchronous temporary-file replacement without fsync or power-loss durability guarantees.

**Sync with lost POST response** consumes one real accepted POST response, then intentionally fails the connection. Reload and sync to confirm the saved server result through catch-up, not a duplicate submission. **Reject pending** confirms the original pending range through the existing HTTP endpoint; it is not undo. The page exposes current visible state, watermarks, pending sequences, conflict and full checkpoint JSON. There is no reset or clear-storage button.

The example-only browser wrapper saves synchronously after creation, after local pending is added, and after each successful receive, including silent acknowledgements. The session store serializes completely before one `setItem()` and loads through the public checkpoint decoder. Only a missing key creates a fresh client; malformed data, denied storage or quota failures throw without clearing the old data or falling back to a snapshot. Storage or synchronization failure stops the connection without rolling back runtime changes. Preserve the displayed current checkpoint before leaving: reload restores only successfully saved work. An incoming listener failure prevents the subsequent receive save.

```sh
node --unhandled-rejections=strict --test test/browser-reload-recovery.test.ts
node --unhandled-rejections=strict --test test/browser-server-recovery.test.ts
node --unhandled-rejections=strict --test test/document-lineage.test.ts
pnpm exec tsc --ignoreConfig --allowJs --checkJs --allowImportingTsExtensions --noEmit --strict --target ES2024 --module NodeNext --moduleResolution NodeNext examples/browser-smoke/smoke.js examples/http-sync-controller.js examples/browser-http-smoke/smoke.js examples/browser-reload-recovery/recovery.js
```

This is same-tab, same-origin recovery for the same guarded document, not a production persistence adapter. Document IDs are lineage markers, not authentication, authorization, schema versions or writer locks. Copying an ID with an older or forked server checkpoint is not detected; all participating hosts must honor the guard. sessionStorage is not a writer lock: an opener or duplicated tab can copy a checkpoint. Do not duplicate the writer or copy its checkpoint into another active writer. Restart recovery requires persistent mode, the same checkpoint directory and port, and sufficient retained history. A different guarded document is rejected without discarding pending. A history gap preserves pending work and returns `false`, never a replacement snapshot. Closing the tab/browser, cross-tab coordination, rollback detection and power-loss durability are not promised. The unauthenticated host has no polling, automatic retry or snapshot fallback. Native tests use an injectable storage double, real HTTP and an actual CLI process termination/restart. Interactive verification uses the Codex built-in browser, not the user's Chrome; unsupported checks must be reported rather than silently replaced.

### Core contract verification map

These checks cover the intended minimal collaboration contract, not a proof of all possible interleavings or production transport guarantees.

| Contract | Focused checks | Integration checks |
| --- | --- | --- |
| Value/List/Text, Unicode and stable-ID tombstones | `runtime.test.ts`, `list.test.ts`, `text.test.ts` | `interleaving.test.ts`, browser core smoke |
| Transactions, rollback and reentrant change delivery | `runtime.test.ts`, collection tests | `resume.test.ts`, `async-resume.test.ts`, HTTP sync |
| Atomic server policy, accept/reject/transform | `runtime.test.ts`, `server-reject.test.ts` | HTTP sync and pending rejection recovery |
| Wire validation and owned JSON data | `wire.test.ts`, checkpoint decoder tests | HTTP sync, installed package consumer |
| Snapshot, checkpoint and pending replay conflicts | `client-checkpoint.test.ts`, `replay-conflict.test.ts` | Browser reload and server recovery |
| Retry deduplication and bounded catch-up | `retry.test.ts`, `history.test.ts` | Interleaving, HTTP sync and lost-ack recovery |
| Save-before-send / save-before-success boundaries | `persistent-resume.test.ts`, `persistent-http-sync.test.ts` | Browser server recovery and document lineage checks |
| Installed ESM and schema-specific declarations | `test/package-consumer/smoke.test.ts` | Native browser core / HTTP smoke |

## Development

Requires Node.js 24 or newer and pnpm 10.

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

Tests run the TypeScript source directly with Node.js's native test runner. Type checking and builds use TypeScript 7's standard `tsc` executable; production builds emit only `src` into `dist`.

```sh
pnpm test:package
```

This separate installed-package smoke test builds and packs a local tarball, then installs it into a fresh temporary ESM consumer outside the checkout. It checks package contents, mixed Value/List/Text synchronization and JSON checkpoint restore, and public declarations with an independent strict NodeNext typecheck (`skipLibCheck: false`). The consumer installs the same exact TypeScript and Node types versions currently installed in the checkout; installation scripts are disabled, and registry access may be needed. Nothing is published. Temporary files are cleaned up on success or failure, and this check is not part of `pnpm test`.

GitHub Actions runs the `CI` workflow on pushes to `main`, pull requests targeting `main`, and manual dispatch. A single Ubuntu 24.04 job uses Node.js 24 and the pnpm version pinned in `packageManager`, installs with `--frozen-lockfile`, then runs typechecking, tests, the production build, browser smoke JSDoc checking, and the installed-package smoke test in sequence. Consumer installation may need registry access. The workflow has read-only repository permissions, no dependency cache, and no publishing or deployment steps. Its Node-based browser smoke checks do not replace the manual desktop Chrome check described above.

The synchronous interleaving tests use three clients, five fixed seeds and 200 scheduling steps per run. They mix Value/List/Text edits, delayed ordered delivery, policy outcomes, explicit rejection, retries and JSON checkpoint restore. Each seed runs twice and compares its full trace and result. Failures report the seed, step, action, client watermarks/pending sequences and trace, retaining the original assertion as the error cause; passing tests stay quiet.

```sh
node --unhandled-rejections=strict --test test/interleaving.test.ts
node --test --test-name-pattern="seed=42" test/interleaving.test.ts
```

These tests check protocol invariants, a simple Value oracle, restore equivalence and final convergence, not an independent implementation of List/Text ordering. Focused tests still define stable-ID and tombstone semantics. A separate history-gap case verifies that missing history preserves pending work rather than replacing the client with a fresh snapshot.

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
- Explicit pending replay conflicts, complete-batch optimistic prefixes and blocked checkpoint restore
- Explicit server rejection with cross-entrypoint retry and example-only manual pending recovery
- Rejected or server-transformed operations
- Synchronous server runtime with batch-level accept, reject, and transform policies
- Strict wire decoding for batches, commits, and snapshots
- Snapshot hydration for new clients
- Late join from the current authoritative state
- Server checkpoint and restore
- Client checkpoint and restore with pending-operation replay
- Example-only synchronous resume with catch-up, pending resubmission, and live routing
- Example-only asynchronous JSON resume with independent FIFO delivery
- Example-only file-backed checkpoint recovery with synchronous JSON storage
- Example-only localhost HTTP snapshot, batch submission, and manual commit catch-up
- Example-only HTTP pending cancellation with ordered acknowledgement and checkpoint recovery
- Example-only file-backed HTTP checkpoint recovery and caller-initiated reconnect
- Example-only native ESM browser core smoke with local assets, JSON restore and blocked recovery
- Example-only same-origin browser HTTP smoke using built ESM and the shared manual sync controller
- Example-only sessionStorage browser checkpoint persistence and manual same-tab reload recovery
- Example-only browser/server checkpoint recovery with an HTTP document lineage guard
- Last-batch retry deduplication and replay, including after restore
- Bounded global commit catch-up, including after restore

Not implemented yet:

- Production transports, retry scheduling, automatic client resume, or reconnects
- Bulk list operations, move, public stable positions, cursors, or rich text
- Production persistence adapters, presence, or undo history
