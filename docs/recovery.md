# Recovery

Use a snapshot for a new client, checkpoints to restore retired writers, and catch-up to deliver missing commits before resubmitting pending work. Recovery orchestration and persistence remain application code.

## Upgrading from 0.1

The published `0.2.0-beta.0` requires an explicitly opened server session before a writer submits its first batch:

```ts
const fresh = createClient(Board, {
  clientId: server.openClient(),
  snapshot: server.snapshot(),
  onBatch: sendLater,
});
```

To resume, stop the old writer and restore its original identity against the same server document. Do not open another session:

```ts
const saved = decodeClientCheckpoint(Board, JSON.parse(savedMessage));
const restored = createClient(Board, {
  clientId: saved.clientId,
  checkpoint: saved,
  onBatch: sendLater,
});
```

Disconnect, offline work and reload keep the session open. `server.closeClient(id)` permanently retires it; call it only after stopping the writer and handling its pending work. `maxClients` now counts open sessions, including those with no batch, rather than all previously processed writers.

Server checkpoints changed from `{ snapshot, replays, history }` to `{ snapshot, lastClientNumber, clients, history }`. Old server checkpoints are rejected; there is no automatic migration or fresh fallback. If your application has 0.1 data, preserve its original files and compatible 0.1 server, and plan data transfer in a separate environment before upgrading. Do not delete the server checkpoint and attach old client checkpoints to a fresh 0.2 server.

Batch, commit and client checkpoint shapes are unchanged, but that does not make them portable across document lineages. A client restore requires the matching schema/document and its original still-open server session. See the [core reference](reference.md#snapshots-checkpoints-and-catch-up) for the checkpoint contract.

## Preparing an upgrade from 0.2.0-beta.0

The next release target is `0.2.0-beta.1`; it is not published yet. Its new default checks incoming List/Text insertion namespaces. Clients created by this package already use the canonical format, so normal submissions need no change.

If your application supplies custom incoming IDs, explicitly keep its own namespace policy when creating or restoring the server:

```ts
const server = createServer(Board, {
  checkpoint: savedServerCheckpoint,
  allowCustomClientNamespaces: true,
});
```

The option is not stored in the checkpoint. It skips only incoming namespace checks, not session, sequence, retry-payload or state validation. Keep authenticating the writer separately. Resolver-generated authoritative IDs do not need this opt-out.

Wire and checkpoint formats remain the same as `0.2.0-beta.0`. For the same schema/document lineage, keep the existing server checkpoint and restore the client's original still-open identity. Existing state and saved results are not rechecked for namespace policy; identical retained retries still return their original result. New custom-ID batches fail without the opt-out, while trusted `reject()` can acknowledge their original payload. Do not clear checkpoints or open a replacement session to bypass an error.

## Late join: a snapshot

```ts
const late = createClient(Board, {
  clientId: server.openClient(),
  snapshot: server.snapshot(),
  onBatch: sendLater,
});
```

The client starts at the snapshot watermark with no pending work. Its first local batch still uses seq 1. The application must not miss commits between snapshot acquisition and live delivery.

## Restore: preserve original pending

```ts
const saved = decodeClientCheckpoint(Board, JSON.parse(savedMessage));
const restored = createClient(Board, {
  clientId: saved.clientId,
  checkpoint: saved,
  onBatch: sendLater,
});
```

Restore rebuilds optimistic state/conflict without sending or emitting changes. Retire the old writer first: one active writer per client ID. Use the same schema and document lineage.

Server checkpoint restore additionally retains the client allocation counter, all open sessions (including those with no batch), last results and bounded history; supply the resolver again. Disconnect/reload does not close the session. Never call `openClient()` to restore an existing identity. Do not substitute a client snapshot for a server checkpoint.

The unreleased server also checks insertion namespaces for new submissions by default. Applications with custom incoming IDs must pass `allowCustomClientNamespaces: true` again on restore; the option is not serialized. Restore does not revalidate namespaces in existing state or retained results, and the last identical retry still returns its original result across `receive()` and `reject()`. New custom-ID submissions need the opt-out. Wire/checkpoint formats are unchanged; see [incoming namespaces](reference.md#incoming-insertion-namespaces).

## Catch up before resubmitting

```ts
const watermark = restored.checkpoint().snapshot.serverSeq;
const commits = server.commitsSince(watermark);
if (commits === null) throw new Error("History gap; preserve checkpoint");
for (const commit of commits) restored.receive(commit);
// Re-read checkpoint now. Catch-up may have acknowledged pending batches.
```

After catch-up, submit the current earliest pending batch, deliver its result in order, then re-read pending. Do not keep a stale pending array. A missing own ack may already be in history, so resending the old batch is unnecessary and can be too old for retry.

`null` means a complete suffix is unavailable. Preserve the checkpoint; replacing it with a fresh snapshot can lose work. History counts commits, not bytes, and defaults to 1000.

## Blocked pending

```ts
const conflict = restored.replayConflict;
if (conflict !== null) {
  console.log(conflict.batch.seq, conflict.operationIndex);
}
```

A rejected insertion may leave a dependent pending deletion with an unknown target. The authoritative commit still advances. Visible state contains only the complete replayable batch prefix; original pending work stays intact.

Blocked clients can read, checkpoint and receive, but cannot make actual edits. Trusted application code can acknowledge abandoned original batches with `server.reject()`. Catch up first, then cancel only the chosen range; already accepted effects are not undone. See [rejection examples](examples.md#manual-pending-rejection).

## Permanently retiring a writer

After its writer is stopped and its pending work is handled, call `server.closeClient(saved.clientId)` and persist the new server checkpoint. Closure removes that session and its retry payload, releases a `maxClients` slot, and prevents all future submissions/retries from it. It is not disconnect, undo or pending recovery. Open a new session for a new writer; issued IDs are never reused in normal same-lineage restore.

Old 0.1 server checkpoints are rejected without migration or fresh fallback. Retained history may still include a closed writer; state, tombstones, history and caller-owned checkpoints are not purged by close.

## Persistence and lineage

Save client pending before sending and server results before delivering. Stop using an advanced in-memory server if its save fails. A successful mutation can be optimistic even when a later callback throws.

The browser recovery example adds document identity envelopes/headers and session storage. These are example contracts, not core checkpoint fields or authentication. Same-origin reload does not prove the server is the same document; lineage and writer coordination belong to the application.

The [examples guide](examples.md) covers synchronous/asynchronous resume, HTTP, file-backed recovery and browser reload. None promises power-loss durability or production reconnect.

[Previous: Server policy and wire](server-wire.md) · [Next: Core reference](reference.md)
