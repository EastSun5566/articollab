# Sync adapter

`articollab/sync` keeps a client document synchronized with a server over HTTP. It follows the [recovery rules](recovery.md) for you: catch up before resubmitting, send only the earliest pending batch, wait for its acknowledgement, retry network failures with backoff, and stop instead of guessing when it cannot continue safely. Updates arrive by polling; there is no push channel yet.

It is part of the `articollab` package and adds no dependencies. Import it only where you need it.

## Serve the routes

`createSyncHandler` turns a `ServerDocument` into a Fetch API handler, `(request: Request) => Promise<Response>`, so it runs wherever `Request` and `Response` exist: Node.js 24 with a framework or a small bridge, Deno, Bun or a worker runtime. It matches the last path segment, so mount it under any prefix:

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

`connectSync` creates the `ClientDocument` and owns its `onBatch`, so local edits are scheduled for submission automatically; several edits in one synchronous block share one pass. It polls every `pollInterval` milliseconds (default 1000; `0` disables polling and you call `sync()` yourself). `sync()` resolves `true` when everything pending is acknowledged.

Decode a stored checkpoint with `decodeClientCheckpoint` before passing it as `checkpoint`. Use one `SyncClient` per writer and client ID, as with any checkpoint.

## Status and failures

| Status | Meaning | What happens next |
| --- | --- | --- |
| `idle` | Caught up and nothing pending | Polls |
| `syncing` | A pass is running | — |
| `retrying` | A network request failed; the outcome is unknown | Retries with exponential backoff and jitter (`retry.initialDelay` 500 ms to `retry.maxDelay` 30 s), catching up first |
| `blocked` | Pending work cannot replay (`doc.replayConflict`) | Keeps polling; call `rejectPending()` to cancel it |
| `gap` | History no longer covers this writer's watermark | Stops; pending work and the checkpoint are kept |
| `failed` | A non-retryable error; see `sync.error` | Stops sending anything |
| `stopped` | `stop()` was called | Later responses are ignored |

A lost response is safe: the next pass catches up first, so a batch the server already accepted is acknowledged rather than sent again, and a resent batch the server has seen is replayed with its original result.

The transport throws an error with `retryable: false` for failures that retrying cannot fix. `createHttpTransport` treats network errors, 408, 429 and 5xx as retryable and throws `SyncHttpError` for other statuses. Malformed responses, out-of-order commits, a submission that was never acknowledged, a failing `save` and a throwing status listener also fail the client, because continuing could lose or duplicate work.

**Saving.** With `save`, the checkpoint is saved after connecting, before any pending batch is sent, and after commits are received, including acknowledgements that change nothing visible. Keep `save` fast; it runs inside each pass.

**History gaps.** Never replace pending work with a snapshot. If nothing is pending, `restartFromSnapshot()` registers a new session, stops the old client and returns a new one; update your references and close the old session on the server if you track it. With pending work, preserve the checkpoint and recover it by hand, for example by raising the server's `historyLimit` and restoring.

## Limits

There is no push delivery, authentication, storage adapter, cross-tab coordination or offline detection: call `sync()` when your app comes back online. The handler serves one document; route requests for different documents to different handlers. See the [core reference](reference.md#sync-adapter) for the complete contract.

[Previous: Recovery](recovery.md) · [Next: Core reference](reference.md)
