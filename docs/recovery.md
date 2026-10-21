# Recovery

Use a snapshot for a new writer and a checkpoint to resume an existing one. Before resubmitting work, catch up so already-accepted batches are acknowledged first.

The snippets use `Board` from [Collections](collections.md) and import factories/decoders from `"articollab"`. `sendLater` is your application's outbound buffer, not a package helper. These are synchronous, in-memory steps; your transport must coordinate catch-up with live delivery.

## Late join: a snapshot

Create a new writer against the current server:

```ts
const late = createClient(Board, {
  clientId: server.openClient(),
  snapshot: server.snapshot(),
  onBatch: sendLater,
});
```

The client immediately sees the snapshot's authoritative state, starts at its watermark, and has no pending work. Its first local batch uses seq 1.

Persist a newly opened session before handing out its ID when recovery matters. Ensure snapshot acquisition and subsequent commit delivery have a gap-free handoff.

## Restore: preserve original pending

Stop the old writer before reconstructing its document. With `savedMessage` containing its client checkpoint:

```ts
const saved = decodeClientCheckpoint(Board, JSON.parse(savedMessage));
const restored = createClient(Board, {
  clientId: saved.clientId,
  checkpoint: saved,
  onBatch: sendLater,
});
```

Restore preserves identity, pending payloads and allocation progress. It reconstructs the optimistic view and any conflict without sending a batch or emitting change. Do not call `openClient()` again for this writer.

To rebuild the server, use its own saved checkpoint and supply application policy/options again:

```ts
const server = createServer(Board, {
  checkpoint: decodeServerCheckpoint(Board, JSON.parse(serverMessage)),
  resolve,
});
```

Here `resolve` is your existing synchronous policy; omit it for accept-only behavior. Restore retains authoritative state, open sessions, allocation progress, retry results and bounded history. A client snapshot is not a server checkpoint.

Use the same schema/document lineage and the original still-open session. Only one writer may use a client ID. Disconnect or reload is not permanent session closure.

### Text snapshot boundaries

The unreleased Text snapshot extension preserves each visible element, including surrogate halves inserted separately. One `insert(0, "😀")` creates one element. Separate insertions of `"\ud83d"` and `"\ude00"` create two; although both cases join to the same string, their lengths, IDs and editing indices differ.

Ordinary Text snapshots remain `{ idList, value }`. Only when joining would merge separate surrogate elements does saving add `surrogateBoundaries`, an array of UTF-16 offsets in `value`. For the two-half example it is `[1]`. This field is an encoding detail: Text operations and observer notifications still use element indices. Snapshot and checkpoint restore preserve the original IDs, element boundaries and tombstones.

New runtimes accept existing valid snapshots without conversion. Older runtimes reject the new field, so upgrade every reader that may receive an affected snapshot or checkpoint. Batch/commit operations and checkpoint envelopes have not changed; this is not a promise of bidirectional format compatibility.

If an older snapshot already lost the boundaries and its present-ID count no longer matches its text, restore still fails. Do not guess segmentation, discard IDs or clear checkpoints. Preserve the original data and any still-running state or operation records; recovery of such data needs separate investigation, not automatic migration.

## Catch up before resubmitting

With `restored` and its matching `server`:

```ts
const watermark = restored.checkpoint().snapshot.serverSeq;
const commits = server.commitsSince(watermark);
if (commits === null) throw new Error("History gap; preserve checkpoint");
for (const commit of commits) restored.receive(commit);
// Re-read pending: catch-up may have acknowledged earlier submissions.
```

For example, batch 1 may have been accepted before the connection lost its response, while batch 2 was never submitted. Catch-up acknowledges batch 1. Only batch 2 still needs submission.

After catch-up, submit the **current earliest** pending batch, deliver its result in order, then read the checkpoint again. Do not save and resend a stale pending array. Confirm that the submitted batch was acknowledged before choosing the next one; successful submission alone is not confirmation.

A result of `null` means the complete suffix is unavailable. Preserve the checkpoint: replacing pending with a fresh snapshot can lose work. History defaults to 1000 commits, not a byte limit.

## Blocked pending

Inspect a restored or live client's first replay failure:

```ts
const conflict = restored.replayConflict;
if (conflict !== null) {
  console.log(conflict.batch.seq, conflict.operationIndex);
}
```

Suppose one pending batch inserted an item and a later batch deletes that item. If the insertion is rejected, the deletion targets an ID that never became authoritative.

The valid server commit still advances the watermark. Visible state contains only the complete replayable batch prefix; the failed batch and later suffix remain pending. Blocked clients can read, checkpoint and receive, but cannot make actual edits. A later commit may make the work replayable again.

## Cancel a range of pending work

Trusted application code can acknowledge abandoned batches with `server.reject(originalBatch)`. This does not undo accepted effects or directly delete pending.

The following function uses the matching in-memory `server` and `restored` client above. It assumes no concurrent submissions or reentrant recovery; listeners may add local work but must not submit it during this function:

```ts
function cancelPending(): boolean {
  const limit = restored.checkpoint().lastLocalSeq;
  const missing = server.commitsSince(
    restored.checkpoint().snapshot.serverSeq,
  );
  if (missing === null) return false;
  for (const commit of missing) restored.receive(commit);

  while (true) {
    const batch = restored.checkpoint().pendingBatches[0];
    if (batch === undefined || batch.seq > limit) return true;
    const { commit } = server.reject(batch);
    restored.receive(commit);
  }
}
```

Catch-up first confirms accepted results without undoing them. The loop rereads pending after each acknowledgement and only cancels through the sequence captured at entry. Listener-created higher sequences remain pending and may themselves be blocked. A return value of `true` confirms the chosen range, not that pending is empty.

Other clients still need these commits through normal ordered delivery or catch-up. Runtime/listener errors propagate; completed commits are not rolled back. Authenticate the writer and coordinate cancellation in a real transport.

## Permanently retiring a writer

After stopping the writer and handling pending, call `server.closeClient(saved.clientId)` and persist the server checkpoint.

Closure removes the session and its last retry, releases a `maxClients` slot, and rejects future submissions from that ID. It changes no authoritative state, tombstones or history. Issued IDs are not reused in normal same-lineage restore.

Do not use closure as disconnect, undo or pending recovery.

## Persistence and lineage

Save client pending before sending and server results before delivering. After each successful client receive, save its checkpoint even when the acknowledgement emits no change event.

A callback failure does not imply runtime rollback. If server saving fails after processing, stop using the advanced in-memory server and reload the last successful checkpoint before continuing.

Your storage and subscription handoff are application responsibilities. Same URL or origin does not prove document identity: bind checkpoints to the same lineage and coordinate one writer per identity. The core provides neither a lineage marker nor a writer lock.

The repository's browser recovery demo uses document-ID envelopes/headers and session storage. Those are application examples, not core wire fields or authentication. Neither ordinary checkpoint containers nor these examples promise power-loss durability or cross-file transactions.

## Upgrading from 0.3 to 0.4

This guidance covers the unreleased 0.4 changes: opt-in `Text.observe()` notifications and the optional Text snapshot boundary field. Neither changes batch/commit operations or checkpoint envelopes.

Existing valid 0.3 snapshots and checkpoints can be restored without conversion for the same schema and document lineage. `Text.observe()` is a new local subscription API, not a wire feature. Initialize your element mirror from the restored Text and subscribe again; subscriptions are not saved in checkpoints. See the [incremental view example](transactions.md#update-a-text-view-incrementally).

Coordinate the upgrade before resuming writes:

1. Preserve matching client/server checkpoint backups and stop the old writers.
2. Upgrade the server, participating clients and every other snapshot/checkpoint reader, including offline clients that will restore later. Keep their original writer identities and document lineage.
3. Restore from the saved checkpoints, catch up and handle pending work through the normal recovery flow, then resume editing. Do not open replacement sessions for restored writers.

Ordinary Text snapshots keep the old format, but adjacent surrogate halves from separate elements require `surrogateBoundaries`. Older runtimes reject that field, even though batches and commits still use the same operations. Once a saved snapshot contains it, a package downgrade is not enough: preserve the data and use compatible readers. Do not strip the field, merge elements or discard IDs to make it load. See [Text snapshot boundaries](#text-snapshot-boundaries), including the limits on recovering older invalid saves.

## Upgrading from 0.2 to 0.3

The 0.3 release adds List `set()` and its `list/set` wire operation. Install the stable release with `pnpm add articollab`.

Roll out support before allowing the new operation:

1. Preserve matching client/server checkpoint backups and stop the old writers.
2. Upgrade the server and every participating client, including writers that will later restore from a checkpoint. Restore their original identities against the same document lineage; do not open replacement sessions.
3. Allow List `set()` only after those runtimes support `list/set`.

Snapshot and checkpoint envelopes have not changed. The 0.3 runtime accepts existing legal 0.2 checkpoints for the same schema and document lineage; no conversion is needed. A 0.2 runtime cannot decode or apply `list/set` in a batch, commit, pending work, retry result or history. Once the document contains this operation, rolling back is not just a package downgrade: do not strip saved operations, clear checkpoints or attach old writers to a fresh server to bypass the incompatibility.

Set updates target the original stable ID even if its index changes. A target deleted by a peer makes the update a no-op, not a replay conflict or resurrection; unrelated operations in that batch can still apply. An unknown ID, such as one from a rejected insertion, still blocks pending replay and requires normal recovery. See [List update semantics](collections.md#update-an-existing-element).

## Upgrading from 0.1

The 0.2 API requires an explicitly opened server session for a fresh writer. Use `server.openClient()` for creation; use the original checkpoint ID for restore. Disconnect keeps the session; `closeClient()` permanently retires it. `maxClients` counts open sessions, including those with no batch.

Server checkpoints changed from `{ snapshot, replays, history }` to `{ snapshot, lastClientNumber, clients, history }`. Old server checkpoints are rejected without migration or fresh fallback.

If you have 0.1 data, preserve its original files and compatible 0.1 server. Plan data transfer in a separate environment. Do not delete the server checkpoint and attach old client checkpoints to a fresh 0.2 server.

Batch, commit and client checkpoint shapes did not change, but they are not portable across document lineages. See the [checkpoint contract](reference.md#snapshots-checkpoints-and-catch-up).

## Upgrading from 0.2.0-beta.0

Starting with `0.2.0-beta.1`, new incoming List/Text insertions require canonical namespaces by default. Normal package clients already generate these IDs.

If your application supplies custom incoming IDs, keep its own namespace policy and explicitly opt out on creation and restore:

```ts
const server = createServer(Board, {
  checkpoint: savedServerCheckpoint,
  allowCustomClientNamespaces: true,
});
```

The option is not serialized. It skips only incoming namespace checks, not session, sequence, retry-payload or state validation. Authenticate the writer separately. Resolver-generated authoritative IDs do not need this opt-out.

Wire/checkpoint formats remain unchanged from beta.0. Existing state and saved results are not retrospectively checked; identical retained retries return their original result. New custom-ID submissions require opt-out, while trusted `reject()` can acknowledge their originals.

Do not clear checkpoints or open replacement sessions to bypass an error. See the [namespace contract](reference.md#incoming-insertion-namespaces).

[Previous: Server policy and wire](server-wire.md) · [Next: Core reference](reference.md)
