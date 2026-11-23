# Sync adapter

Use `articollab/sync` to submit edits and receive ordered commits over HTTP or a WebSocket. The client catches up before resubmitting and waits for each batch's acknowledgement before sending the next.

## Serve the routes

Mount `createSyncHandler` under a path such as `/sync/` in your HTTP host. Supply your application's `authorizeWriter` and `saveServerCheckpoint` functions.

```ts
import { createServer, defineDocument, list } from "articollab";
import { createSyncHandler } from "articollab/sync";

const Board = defineDocument({ items: list<string>() });
const server = createServer(Board);

export const handleSync = createSyncHandler(Board, server, {
  authorize: (request, action) => authorizeWriter(request, action),
  saveCheckpoint: (checkpoint) => saveServerCheckpoint(checkpoint),
});
```

| Route | Method | Purpose |
| --- | --- | --- |
| `clients` | POST `{}` | Open a writer session; `201 { clientId, snapshot }` |
| `batches` | POST batch | Submit the next batch. The commit confirms it when delivered. |
| `commits?since=n` | GET | Every commit after watermark `n`, or `null` when history no longer covers it |
| `events?since=n` | GET | A `text/event-stream` of the commits after `n`, then each new commit; see [Live updates](#live-updates) |
| `rejections` | POST batch | Confirm cancellation when `allowRejections: true`. |

Authenticate callers and authorize each request, including the requested `clientId` on submissions and rejections. The handler waits for `saveCheckpoint` before serving a commit. If saving fails, restore the last saved checkpoint and recreate the handler.

## Connect a client

```ts
import { createHttpTransport, connectSync } from "articollab/sync";

const transport = createHttpTransport({
  url: "https://example.com/sync/",
  headers: () => ({ authorization: `Bearer ${token}` }),
});
const sync = await connectSync(Board, { transport });

sync.doc.state.items.push("Sent automatically");
sync.on("status", (status) => console.log(status));
```

`connectSync` opens a writer session and schedules submissions as you edit. Call `await sync.sync()` to run a pass now. It resolves `true` once all pending batches are acknowledged. When the app comes back online, call it to catch up immediately.

## Persist checkpoints

To keep unsent edits across reloads, pass a `store` when you call `connectSync`. Built-in stores require Articollab 0.8 or later. Use the same `Board` and `transport` as above.

```ts
import { connectSync, openIndexedDbStore } from "articollab/sync";

const store = await openIndexedDbStore({ database: "my-app", key: `${documentId}:writer` });
const sync = await connectSync(Board, { transport, store });
```

The store restores the same writer and pending edits after a reload. If another tab holds the store's Web Lock, opening it throws `CheckpointLockedError`. Call `sync.close()` when the writer is done to release the store.

### Open the same key in several tabs

`slots` requires [Articollab 0.10 or later](reference.md#compatibility).

One stored writer belongs to one tab at a time. To let several tabs edit, give the key `slots`:

```ts
const store = await openIndexedDbStore({ database: "my-app", key: `${documentId}:writer`, slots: 8 });
console.log(store.slot); // 0 in the first tab, 1 in the second, …
```

Each tab takes a free slot and is its own writer, with its own session, pending edits, undo history and presence. Tabs see each other's edits through the server, as other devices do, so not while offline. When a tab closes, the browser releases its lock and the next tab that opens takes that slot over, including edits the closed tab had not sent yet: free slots with pending edits are taken first, then slots with a saved checkpoint, then the lowest. Opening throws `CheckpointLockedError` only when every slot is held. At most `slots` writers of a key are open at once in one browser profile. Each slot keeps its session across reloads, and a session is registered only when a tab takes an empty slot, as without `slots`. Slot 0 is the key itself, so a writer saved without `slots` is kept.

Include the document's identity in the storage key, and verify that it matches the server document before calling `connectSync`. The same rule applies to file paths. The lock coordinates access to one stored writer; your application binds that writer's checkpoint to its [document lineage](recovery.md#persistence-and-lineage).

For a Node.js client, open a file store.

```ts
import { openFileStore } from "articollab/sync/node";

const sync = await connectSync(Board, { transport, store: await openFileStore("writer.checkpoint.json") });
```

The default file lock uses [`navigator.locks`](https://nodejs.org/download/release/latest-v24.x/docs/api/globals.html#navigatorlocks), which is available from Node.js 24.5. On an earlier Node.js 24 release, pass a lock manager in `openFileStore(path, { locks })`.

Give each process its own checkpoint file. If the stored checkpoint cannot be decoded, `connectSync` rejects. Inspect the data before clearing it.

For application-managed storage, pass a checkpoint decoded with `decodeClientCheckpoint` and a `save` callback instead. Local edits queue a save even when a network request is pending.

## Live updates

The client opens a server-sent events (SSE) stream after catching up. It pauses polling while the stream is open. On EOF or a retryable error, it catches up and reconnects. If your host lacks SSE support, pass `push: false` to poll instead.

```ts
sync.on("push", (state) => setLiveIndicator(state === "open")); // "off" | "connecting" | "open"
```

If you use `EventSource` directly, fetch and apply `GET /commits` from the last applied sequence before reconnecting after an unexpected end. Apply that catch-up before opening another stream, especially after [the stream queue fills](reference.md#sync-adapter).

When committing outside the handler, save the checkpoint before calling `await handleSync.notify()`.

## Use WebSocket

WebSocket requires [Articollab 0.10 or later](reference.md#compatibility).

Over a WebSocket, a writer's requests and pushes share one connection. That suits frequent presence updates, such as carets, and hosts built around sockets. HTTP with SSE stays the simpler default: it passes through proxies and CDNs that stream responses, and headers carry authorization.

The same handler serves both. Give `accept` each socket with its upgrade request. With Node.js and the [`ws`](https://github.com/websockets/ws) package:

```ts
import { WebSocketServer } from "ws";

const sockets = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (incoming, socket, head) => {
  sockets.handleUpgrade(incoming, socket, head, (ws) => {
    const request = new Request(new URL(incoming.url ?? "/", "https://example.com"), {
      headers: { cookie: incoming.headers.cookie ?? "" },
    });
    const connection = handleSync.accept(ws, request);
    ws.on("message", (data) => connection.message(Array.isArray(data) ? Buffer.concat(data) : data));
    ws.on("close", () => connection.close());
  });
});
```

Deno, Bun and Cloudflare Workers sockets also have `send` and `close`. In Deno:

```ts
Deno.serve((request) => {
  if (request.headers.get("upgrade") !== "websocket") return handleSync(request);
  const { socket, response } = Deno.upgradeWebSocket(request);
  const connection = handleSync.accept(socket, request);
  socket.onmessage = (event) => connection.message(event.data);
  socket.onclose = () => connection.close();
  return response;
});
```

On the client, swap the transport:

```ts
import { connectSync, createWebSocketTransport } from "articollab/sync";

const transport = createWebSocketTransport({ url: () => `wss://example.com/sync/socket?token=${token}` });
const sync = await connectSync(Board, { transport });
```

Browsers cannot set headers on a WebSocket, so authenticate with a cookie or a token in the URL; a function `url` is read before each connection. `authorize` receives the upgrade request for every message. The socket opens on first use and reopens after it drops, and `sync.close()` closes it. Errors use the same statuses as HTTP, as `SyncRequestError`.

## Share presence

Presence requires [Articollab 0.10 or later](reference.md#compatibility).

Presence is what each writer wants the others to see right now, such as a name and a selection, but that is not part of the document. Enable it on the handler and the client, and it travels over the same push channel:

```ts
const handleSync = createSyncHandler(Counter, server, { presence: {} });
const transport = createHttpTransport({ url: "https://example.test/sync/" });
const sync = await connectSync(Counter, { transport, presence: {} });

sync.presence.set({ name: "Ann", editing: "count" });
sync.presence.on("change", (peers) => {
  for (const [clientId, state] of peers) console.log(clientId, state);
});
```

`peers` holds every other writer's latest state, never your own. A state is any JSON value; pass a `schema` to either side to validate it, as with [payloads](collections.md#validate-payloads). The client sends its state again every 10 seconds, and the handler drops a state it has not received for 30 seconds, so a closed tab disappears on its own; `set(null)` or `sync.close()` removes it at once, and so does a WebSocket closing. To share a text selection, send [cursors](collections.md#stable-positions-with-cursors) and resolve them with `decodeCursor()` and `cursorIndex()` on arrival.

Presence lives only in the handler's memory: it is not saved, not part of checkpoints or history, and not shared between server instances. Delivery is best-effort, and while the push channel is down `peers` is empty.

## Status and failures

| Status | Meaning | What happens next |
| --- | --- | --- |
| `idle` | Caught up and nothing pending | Waits for pushed commits, or polls |
| `syncing` | A pass is running | — |
| `retrying` | A network request failed | Catches up before retrying |
| `blocked` | Pending work cannot replay (`doc.replayConflict`) | Receives commits while waiting for the conflict to clear |
| `gap` | History no longer covers this writer's watermark | Stops; pending work and the checkpoint are kept |
| `failed` | An unrecoverable error | Stops syncing. Inspect `sync.error`. |
| `closed` | `close()` was called | Later responses are ignored |

If you choose to discard blocked work, call `rejectPending()`. It cancels batches pending when you call it and catches up first to confirm any edits the server already accepted. Each cancelled batch is reported by the document's [`transform`](server-wire.md#accept-transform-or-reject) event, so ignore those events while your own call runs.

After a history gap, preserve the checkpoint if pending work remains. With an empty pending queue, call `restartFromSnapshot()` and use the returned client. Close the old session on the server if your application manages sessions.

See the [reference](reference.md#sync-adapter) for exact retry, persistence and shutdown behavior.

[Previous: Recovery](recovery.md) · [Next: Core reference](reference.md)
