# Sync adapter

`articollab/sync` keeps a client document synchronized with a server over HTTP. It follows the [recovery rules](recovery.md) for you: catch up before resubmitting, send only the earliest pending batch, wait for its acknowledgement, retry network failures with backoff, and stop instead of guessing when it cannot continue safely. New commits arrive over a push channel (server-sent events) when it is available, and by polling otherwise.

It is part of the `articollab` package and adds no dependencies. Import it only where you need it.

## Serve the routes

`createSyncHandler` turns a `ServerDocument` into a Fetch API handler, `(request: Request) => Promise<Response>` with a `notify()` method, so it runs wherever `Request` and `Response` exist: Node.js 24 with a framework or a small bridge, Deno, Bun or a worker runtime. It matches the last path segment, so mount it under any prefix:

```ts
import { createServer, defineDocument, list } from "articollab";
import { createSyncHandler } from "articollab/sync";

const Board = defineDocument({ items: list<string>() });
const server = createServer(Board);

export const handleSync = createSyncHandler(Board, server, {
  // Bind each request to a writer here; the handler does not authenticate.
  authorize: (request, { action, clientId }) => request.headers.get("authorization") !== null,
  // Persist before answering. If this throws, the handler answers 503 until you restart it.
  saveCheckpoint: (checkpoint) => { /* write JSON.stringify(checkpoint) */ },
});
```

| Route | Method | Purpose |
| --- | --- | --- |
| `clients` | POST `{}` | Open a writer session; `201 { clientId, snapshot }` |
| `batches` | POST batch | Submit the next batch; `204` means received, not acknowledged |
| `commits?since=n` | GET | Every commit after watermark `n`, or `null` when history no longer covers it |
| `events?since=n` | GET | A `text/event-stream` of the commits after `n`, then each new commit; see [Live updates](#live-updates) |
| `rejections` | POST batch | Cancel pending work; disabled unless `allowRejections: true` |

The handler validates JSON content types, a body size limit (`bodyLimit`, default 1 MiB) and every batch with `decodeClientBatch`, then applies the normal namespace check. Errors use fixed messages and never echo the request. Writes are processed one at a time, and catch-up waits for pending saves, so a commit is never served before its checkpoint is saved.

`authorize(request, { action, clientId })` runs before each action: `register`, `submit` and `reject` (with the batch's `clientId`) and `catchUp`. Return `false` for a 403. Rejections can cancel any writer's pending work, which is why they are off by default; enable them only for requests you can tie to that writer.

## Connect a client

```ts
import { createHttpTransport, connectSync } from "articollab/sync";

const sync = await connectSync(Board, {
  transport: createHttpTransport({
    url: "https://example.com/sync/",
    headers: () => ({ authorization: `Bearer ${token}` }),
  }),
  checkpoint: savedCheckpoint, // Omit for a new writer; a session is registered for you.
  save: (checkpoint) => storage.put(JSON.stringify(checkpoint)),
});

sync.doc.state.items.push("Sent automatically");
sync.on("status", (status) => console.log(status));
```

`connectSync` creates the `ClientDocument` and owns its `onBatch`, so local edits are scheduled for submission automatically; several edits in one synchronous block share one pass. While no push channel is open it polls every `pollInterval` milliseconds (default 1000; `0` disables polling and you call `sync()` yourself). `sync()` resolves `true` when everything pending is acknowledged.

`rejectPending()` captures the local sequence when you call it, even if it must wait for a running pass. It cancels only the pending batches up to that sequence, catching up first so accepted work is never undone. Later edits are ordinary pending work: they may sync normally, or stay blocked if they depend on an insertion that was cancelled.

Decode a stored checkpoint with `decodeClientCheckpoint` before passing it as `checkpoint`. Use one `SyncClient` per writer and client ID, as with any checkpoint.

## Persist checkpoints

A writer's pending edits live in its checkpoint. Give `connectSync` a `store` and it restores the saved checkpoint, or registers a session when there is none, then saves after every change:

```ts
import { CheckpointLockedError, connectSync, createHttpTransport, openIndexedDbStore } from "articollab/sync";

let store;
try {
  store = await openIndexedDbStore({ database: "my-app", key: `${documentId}:writer` });
} catch (error) {
  if (error instanceof CheckpointLockedError) showMessage("This document is open in another tab.");
  throw error;
}
const sync = await connectSync(Board, { transport, store });
```

After a reload, the same writer resumes with its unsent edits and sends them. The store takes a [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API), so a second tab opening the same `key` gets `CheckpointLockedError` instead of a second writer with the same client ID; `sync.stop()` releases it. Include the document's identity in `key`: a checkpoint belongs to one document lineage, and restoring it against a different server document fails.

In Node.js, use a file:

```ts
import { openFileStore } from "articollab/sync/node";

const sync = await connectSync(Board, { transport, store: await openFileStore("writer.checkpoint.json") });
```

Each save writes a temporary file and renames it over the checkpoint, so the file always holds a complete checkpoint. The lock covers one process only; give each process its own file. A stored value that cannot be decoded rejects `connectSync` instead of starting over, so the pending work is not lost silently: inspect it, then `store.clear()` if you decide to discard it. To write your own store, implement `CheckpointStore`: `load`, `save`, `clear` and `close`.

## Live updates

With `createHttpTransport`, the client opens `GET events?since=n` after its first pass and keeps it open. The handler first sends the saved commits after `n`, then every new commit as soon as its checkpoint is saved, as `event: commits` with the commits as JSON and the last server sequence as the event `id`. A `: ping` comment every `heartbeatInterval` milliseconds (default 15000) keeps proxies from closing an idle stream.

The handler limits open streams with `maxEventStreams`, including concurrent requests. Aborted requests and cancelled readers release their slots and heartbeat timers; a request that aborts before its stream opens starts no heartbeat.

Each stream can queue up to 4 MiB of UTF-8 event data. Heartbeats are skipped when they do not fit. If a commit frame is too large or would exceed the remaining space, the handler lets the reader drain the complete frames already queued and then ends that stream. Other streams and server writes can continue. The limit covers the handler's stream queue; the HTTP host and network can buffer data separately.

Pushed commits go through the same checks as catch-up. A delivery that continues the client's watermark is applied directly, with no extra request; duplicates are ignored, and anything that skips ahead triggers a normal catch-up. While the channel is open the client does not poll. If the stream ends normally, has a retryable error or carries no traffic for `pushTimeout` milliseconds (default 45000), the client catches up at once, polls, and reconnects with the same backoff as other retries.

A push error marked `retryable: false`, including a 403/404 response or malformed JSON, fails the whole connection instead of silently switching to polling. Its first error remains in `sync.error`; polling and reconnect timers stop. If the server does not support SSE, explicitly use `push: false`.

```ts
sync.on("push", (state) => setLiveIndicator(state === "open")); // "off" | "connecting" | "open"
```

The stream uses `fetch`, so `headers()` such as an authorization header apply to it, and `authorize` sees it as `catchUp`. Pass `push: false` to `connectSync` to poll only. On the server, `maxEventStreams` (default 1000) bounds open streams; further requests get 503. Some hosting platforms limit how long a response may stream; the client recovers by reconnecting, or set `push: false` there.

If you use `EventSource` directly, catch up with `GET /commits` from the last applied sequence after a stream ends unexpectedly. Apply those commits before opening another stream, so a catch-up frame that exceeds the stream budget does not keep closing every reconnection.

The handler pushes the commits it applies itself. If your server also commits outside the handler, for example with a direct `server.receive()`, save the checkpoint and then call `await handleSync.notify()` to push those commits.

## Status and failures

| Status | Meaning | What happens next |
| --- | --- | --- |
| `idle` | Caught up and nothing pending | Waits for pushed commits, or polls |
| `syncing` | A pass is running | — |
| `retrying` | A network request failed; the outcome is unknown | Retries with exponential backoff and jitter (`retry.initialDelay` 500 ms to `retry.maxDelay` 30 s), catching up first |
| `blocked` | Pending work cannot replay (`doc.replayConflict`) | Keeps polling; call `rejectPending()` to cancel it |
| `gap` | History no longer covers this writer's watermark | Stops; pending work and the checkpoint are kept |
| `failed` | A non-retryable error; see `sync.error` | Stops sending anything |
| `stopped` | `stop()` was called | Later responses are ignored |

A lost response is safe: the next pass catches up first, so a batch the server already accepted is acknowledged rather than sent again, and a resent batch the server has seen is replayed with its original result.

The transport throws an error with `retryable: false` for failures that retrying cannot fix. `createHttpTransport` treats network errors, 408, 429 and 5xx as retryable and throws `SyncHttpError` for other statuses. Malformed responses, out-of-order commits, a submission that was never acknowledged, a failing `save` and a throwing status listener also fail the client, because continuing could lose or duplicate work.

**Stopping.** `stop()` is terminal, as is `failed`. Queued work cannot restart either state. Work called before stopping but still waiting or running resolves `false` when interrupted by stop; new `sync()`/`rejectPending()` calls after stop reject. Queued work interrupted by failure rejects with the same `sync.error`. Requests or saves already started may still complete, but the client ignores their late results and starts no further work. Completed mutations are not rolled back, pending work is not purged, and stopping after failure keeps the original failure visible.

**Saving.** With `save` or `store`, the checkpoint is saved after connecting, after every local edit, before any pending batch is sent, and after commits are received, including acknowledgements that change nothing visible. Saves run one at a time and always save the latest checkpoint, so a slow save never lets an older one overwrite a newer one. A save after a local edit does not wait for a pass that is waiting on the network. Keep saving fast; a pass waits for it.

**History gaps.** Never replace pending work with a snapshot. If nothing is pending, `restartFromSnapshot()` registers a new session, stops the old client and returns a new one; update your references and close the old session on the server if you track it. With pending work, preserve the checkpoint and recover it by hand, for example by raising the server's `historyLimit` and restoring.

## Limits

There is no authentication, server-side storage adapter or offline detection: call `sync()` when your app comes back online. Checkpoint stores keep one writer per tab or process; they do not share a writer between tabs. The handler serves one document; route requests for different documents to different handlers. See the [core reference](reference.md#sync-adapter) for the complete contract.

[Previous: Recovery](recovery.md) · [Next: Core reference](reference.md)
