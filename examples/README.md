# Articollab examples

These are application-layer walkthroughs, not package APIs or production transport/storage adapters. Read the [core contracts](../docs/reference.md#core-contracts) first. Imports of example modules do not run their demos; direct CLI execution does.

All commands and snippet imports below are relative to the **repository root**, not this Markdown file. Use Node 24 and the pinned pnpm, run `pnpm install --frozen-lockfile` once, and build before starting browser hosts. Private repository access is required; this guide and the example code are not included in the package tarball.

| Start here | What it demonstrates |
| --- | --- |
| [In-memory broadcast](#in-memory-broadcast-walkthrough) | Synchronous policy, late join and ordered reentrant delivery |
| [In-memory resume](#in-memory-resume-example) | Catch-up before pending resubmission and live handoff |
| [Manual pending rejection](#manual-pending-rejection) | Confirm cancellation without purge or undo |
| [Asynchronous resume](#asynchronous-jsonresume-example) | JSON delivery with independent FIFO chains |
| [File-backed recovery](#file-backed-checkpoint-recovery-example) | Save barriers and process-interruption recovery |
| [HTTP sync](#localhost-http-sync-example) | Real localhost snapshot, submission, catch-up and explicit cancellation |
| [File-backed HTTP](#file-backed-http-recovery-example) | Rebuild hosts/connections after ambiguous responses |
| [Browser core smoke](#browser-core-smoke-example) | Production ESM collection/recovery checks |
| [Browser HTTP smoke](#browser-http-smoke-example) | Browser clients through the shared HTTP sync controller |
| [Browser reload recovery](#browser-reload-recovery-example) | Session storage, server restart and document lineage protection |

Use one writer per client ID/document lineage and one writer per checkpoint file. None of these helpers adds authentication, automatic history-gap recovery, rebase or power-loss durability. If a helper returns `false` or throws, preserve the checkpoint; replacing pending work with a fresh snapshot can lose edits.

## In-memory broadcast walkthrough

This fuller version of the quick start applies a synchronous policy and queues commit delivery before handling listener-created commits. The registry is application-owned; the library does not manage clients. Fresh clients hydrate from the current snapshot. Retry routing assumes the source is still registered and waiting for that commit; applications must avoid duplicate delivery and catch up earlier commits first.

```ts
import {
  createClient,
  createServer,
  defineDocument,
  list,
  text,
  value,
  type ClientBatch, type ClientDocument, type DocumentOperation, type ServerCommit,
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
type Shape = typeof Board.definition;
const clients = new Map<string, ClientDocument<Shape>>();
const commitQueue: Array<{ commit: ServerCommit<DocumentOperation<Shape>>; recipients: ClientDocument<Shape>[] }> = [];
let broadcasting = false;

function send(batch: ClientBatch<DocumentOperation<Shape>>): void {
  const { commit, replayed } = server.receive(batch);
  const recipients = replayed
    ? [clients.get(batch.clientId)!]
    : [...clients.values()];
  commitQueue.push({ commit, recipients });
  if (broadcasting) return;

  broadcasting = true;
  try {
    while (commitQueue.length > 0) {
      const { commit, recipients } = commitQueue.shift()!;
      for (const client of recipients) client.receive(commit);
    }
  } finally {
    broadcasting = false;
  }
}

function connect(clientId: string): ClientDocument<Shape> {
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

The FIFO protects broadcast order within this process, not delivery over a real network. If application callbacks throw, stop and inspect checkpoints rather than treating the walkthrough as a production error-recovery loop.

## In-memory resume example

Run the synchronous example directly:

```sh
node examples/resume.ts
```

It demonstrates a lost acknowledgement, unsent mixed Value/List/Text mutations, checkpoint JSON decoding, catch-up, and a subsequent live edit. The same example-only helper is used by the end-to-end tests. This restore excerpt assumes decoded `serverCheckpoint` and `clientCheckpoint` from the same document lineage, with the old writers stopped; do not attach a saved client to a fresh server:

```ts
import { createServer } from "./src/index.ts";
import { Board, createExampleNetwork } from "./examples/resume.ts";

const server = createServer(Board, { checkpoint: serverCheckpoint });
const network = createExampleNetwork(server);
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

## Manual pending rejection

Run the manual recovery example:

```sh
node examples/reject-pending.ts
```

Its example-only `rejectPending(server, doc)` captures the initial `lastLocalSeq`, then applies the complete catch-up before rejecting any remaining pending batches up to that cutoff. It re-reads the earliest pending after each acknowledgement, so it neither resubmits already-confirmed work nor relies on change events for silent acknowledgements. Returning `true` means the targeted batches are confirmed, not that all later pending work is empty: listener-created higher-sequence edits remain pending. New edits may depend on a cancelled insertion and become blocked themselves; inspect `doc.replayConflict` again rather than assuming recovery made every suffix replayable. The explicit action cancels the whole original pending range, including mutations that were still replayable, rather than only the failing operation.

If retained history is insufficient, it returns `false` without rejecting anything or replacing the document. Exceptions propagate; completed commits are not rolled back and the latest checkpoint retains unconfirmed work. Recovery cannot run concurrently or reentrantly for the same server or document. The example uses manual submission with no other server writes interleaving, no background pump and no transport queue; peers catch up separately. A production caller must coordinate submission, persistence, commit delivery and authorization. No helper automatically requests cancellation. The HTTP helper offers an explicit action as described below; the package client API and wire formats remain unchanged.

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

The example-only `createCheckpointStore(directory)` requires an existing directory. It provides `loadServer()`, `saveServer(checkpoint)`, `loadClient(clientId)`, and `saveClient(checkpoint)`. Loads read only final checkpoint files, parse JSON, and use the existing checkpoint decoders; only a missing file returns `null`. Corrupt JSON, invalid checkpoints, mismatched client IDs, and other filesystem errors throw rather than silently starting fresh. Use a new client ID for a genuinely new client. If an existing writer's client file is missing, do not reset its identity or discard its pending work.

The asynchronous helper accepts optional `saveClientCheckpoint` and `saveServerCheckpoint` callbacks. They synchronously return `undefined`, so an async callback fails type checking. They are trusted application code: save only, without reentering the network or mutating documents. When omitted, the helper behaves as before.

Saving happens at these boundaries:

- Connect saves the initial or restored client before registering it.
- Every local batch saves the complete current client checkpoint before starting a send, including offline and recovery edits.
- Successful incoming application saves the latest client checkpoint, even for a silent own acknowledgement. Already-consumed commits are skipped.
- Each new server result is saved before any delivery is queued, including rejection and transformation. A replay receipt does not save the server again.

Local state changes optimistically before saving, and a save failure may throw from the mutation itself; the batch and visible state are not rolled back. Saving failures stop the network and reject waiting operations. Do not reuse an advanced in-memory server after its save fails: rebuild from the last successfully saved files. If an incoming listener throws, preserve that error and do not attempt an extra save that could mask it. Only successfully saved work is promised recoverable.

Files are `server.json` and `client-<hex>.json`, where `<hex>` is the lowercase hex encoding of the client ID's UTF-16LE bytes. For example, `a` uses `client-6100.json` and `A` uses `client-4100.json`. This lossless encoding avoids case and Unicode-normalization collisions on local filesystems. Each save serializes completely, writes a same-directory `<target>.tmp` file, then renames it over the final checkpoint file; newly created files use mode `0o600`. Orphan temporary files are ignored on load. Writes block the event loop and require one writer per file in a trusted local directory. This verifies process interruption and restart, not power-loss durability: there is no fsync/directory-sync protocol, cross-file transaction, lock, migration, production storage adapter, or recovery beyond retained history.

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

This demo combines the existing JSON checkpoint store with real localhost HTTP. It saves mixed optimistic edits, loses a POST response after the server has saved its result, closes the old host, and rebuilds server and clients from the saved checkpoints. Manual sync confirms the accepted batch through catch-up and submits only remaining pending work, then demonstrates subsequent edits and convergence. Importing the demo has no side effects; direct execution owns and cleans up its temporary directory and hosts.

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

Open the printed localhost URL in your browser. The page runs three fixed scenarios: optimistic mixed edits with delayed delivery, JSON checkpoint restore with tombstones and pending work, and explicit rejection followed by blocked recovery and resumed editing. Each scenario shows client watermarks, pending sequences, visible values and conflict state. A successful run reports `PASS: all 3 scenarios completed`; **Run again** uses fresh objects, and reloading runs the checks again. Module-loading or assertion failures appear on the page instead of being reported as success.

Both clients and the authoritative server run inside the page. The Node host only serves local assets: the production ESM build and the installed articulated/sparse-array-rled ESM builds. An import map resolves package names, while fixed extensionless asset aliases accommodate the dependencies' relative imports. No JavaScript is rewritten, and no CDN, bundler, Node polyfill or new dependency is used. The aliases are example-only loading support, not a package loader contract or a production browser transport. This smoke check exercises the browser used for interactive verification, not a complete browser compatibility matrix.

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

Open the printed localhost URL in your browser. Unlike the core smoke above, the authoritative server runs in Node; the two browser clients use native `fetch` for snapshots, batch submission, ordered commit catch-up and explicit rejection. The page and fixed ESM assets share the API's origin, so no CORS, CDN, bundler or Node polyfill is needed. Both Node and browser wrappers use the same example-only synchronization controller; their initialization remains separate so source-based Node tests do not require a production build.

Three fixed scenarios check mixed optimistic edits and silent acknowledgements, JSON checkpoint restore with tombstones and pending work, and rejection followed by blocked recovery and resumed editing. Each reports client/server state, watermarks, pending sequences and conflicts; failures stop the run and appear on the page. **Run again** and reload create new UUID client namespaces and start from the current server snapshot, not a reset document. The demo policy rejects only the first batch of each `reject-` client, then accepts later work. Assume no other writers while a smoke run is in progress.

```sh
node --unhandled-rejections=strict --test test/browser-http-smoke.test.ts
pnpm exec tsc --ignoreConfig --allowJs --checkJs --allowImportingTsExtensions --noEmit --strict --target ES2024 --module NodeNext --moduleResolution NodeNext examples/browser-smoke/smoke.js examples/http-sync-controller.js examples/browser-http-smoke/smoke.js
```

The focused Node tests run the same browser-compatible module with built ESM and real localhost HTTP, but do not replace checking all three scenarios, **Run again** and reload in your browser. Synchronization is manual: there is no polling, automatic retry, browser storage or production reconnect. The host is unauthenticated, including `/rejections`; client IDs are namespaces, not authorization. Checkpoint restore is in memory, cancellation is not undo, and module/HTTP/decode/listener failures are not automatically repaired.

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

This is same-tab, same-origin recovery for the same guarded document, not a production persistence adapter. Document IDs are lineage markers, not authentication, authorization, schema versions or writer locks. Copying an ID with an older or forked server checkpoint is not detected; all participating hosts must honor the guard. sessionStorage is not a writer lock: an opener or duplicated tab can copy a checkpoint. Do not duplicate the writer or copy its checkpoint into another active writer. Restart recovery requires persistent mode, the same checkpoint directory and port, and sufficient retained history. A different guarded document is rejected without discarding pending. A history gap preserves pending work and returns `false`, never a replacement snapshot. Closing the tab/browser, cross-tab coordination, rollback detection and power-loss durability are not promised. The unauthenticated host has no polling, automatic retry or snapshot fallback. Native tests use an injectable storage double, real HTTP and an actual CLI process termination/restart. Interactive browser verification complements these automated checks.
