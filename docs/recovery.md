# Recovery

Use a snapshot for a new client, checkpoints to restore retired writers, and catch-up to deliver missing commits before resubmitting pending work. Recovery orchestration and persistence remain application code.

## Late join: a snapshot

```ts
const late = createClient(Board, {
  clientId: "new-writer",
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

Server checkpoint restore additionally retains per-client last results and bounded history; supply the resolver again. Do not substitute a client snapshot for a server checkpoint.

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

## Persistence and lineage

Save client pending before sending and server results before delivering. Stop using an advanced in-memory server if its save fails. A successful mutation can be optimistic even when a later callback throws.

The browser recovery example adds document identity envelopes/headers and session storage. These are example contracts, not core checkpoint fields or authentication. Same-origin reload does not prove the server is the same document; lineage and writer coordination belong to the application.

The [examples guide](examples.md) covers synchronous/asynchronous resume, HTTP, file-backed recovery and browser reload. None promises power-loss durability or production reconnect.

[Previous: Server policy and wire](server-wire.md) · [Next: Core reference](reference.md)
