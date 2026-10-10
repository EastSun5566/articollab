# Server policy and wire data

Submit batches to decide their authoritative effect, decode untrusted messages at the transport boundary, and deliver commits in global order. Policy, validation and delivery solve different problems.

## Submit a batch

Use the `server`, buffered `batch`, `doc` and `peer` from the [Counter quick start](quick-start.md). Replace its submission step with:

```ts
const receipt = server.receive(batch);
console.log(receipt.replayed); // false for this new batch
for (const client of [doc, peer]) client.receive(receipt.commit);
console.log(doc.checkpoint().pendingBatches.length); // 0
```

The receipt contains the commit and local routing metadata. Send the **commit**, not the receipt, to clients. The source must receive it too: server acceptance alone does not remove pending work.

Fresh writers need an ID from `server.openClient()`. Persist that session before handing out the ID if you need crash recovery. Opening a session is not authentication.

## Accept, transform or reject

Import `createServer` from `"articollab"` and use the Counter schema from the quick start. Create this server instead of the accept-only server:

```ts
const server = createServer(Counter, {
  resolve({ batch, snapshot }) {
    if (snapshot.data.count >= 10) return [];
    return batch.operations.map((operation) => ({
      ...operation, value: Math.min(operation.value, 10),
    }));
  },
});
```

A pending `set(12)` displays 12 locally, then becomes 10 after receiving its transformed commit. Once the authoritative count is 10, this policy rejects later batches.

The resolver receives the pre-batch snapshot and returns operations synchronously. Return `batch.operations` to accept unchanged, a valid operation set to transform, or `[]` to acknowledge without an authoritative effect. It need not return one operation per input.

For explicit cancellation, trusted application code can call `server.reject(originalBatch)`. It skips the resolver and incoming operation application. A previously accepted batch cannot become rejected: an identical latest retry returns its original result through either entrypoint.

Resolver throws or invalid output leave server state and sequences unchanged. Side effects cannot be rolled back; keep decisions pure. If a Text transform reuses incoming IDs, preserve the code-point length. Different-length insertions need globally unique application-supplied ID ranges.

## Decode at the transport boundary

Import `decodeClientBatch` and `decodeServerCommit` from `"articollab"`. With a Counter server/client and a JSON message containing its original batch:

```ts
const batch = decodeClientBatch(Counter, JSON.parse(batchMessage));
const { commit } = server.receive(batch);
const commitMessage = JSON.stringify(commit);
doc.receive(decodeServerCommit(Counter, JSON.parse(commitMessage)));
```

The source receives the authoritative result through the same decoding boundary as peers. In a networked application, deliver earlier missing commits before this one.

`JSON.parse()` is your application's job. A decoder accepts parsed `unknown`, checks fields, schema paths, collection kinds, JSON payloads, sequences and IDs, then deeply copies/freezes the result. `WireDecodeError.path` identifies an invalid field with a JSON Pointer, such as `/operations/0/id/counter`.

Decoding does not validate the business shape of TypeScript `T`. An unknown anchor can be structurally valid and decode successfully, then fail authoritative application atomically. See the [wire/error contract](reference.md#wire-validation-and-error-boundaries).

## Incoming insertion namespaces

New `server.receive()` batches must use the canonical writer/collection insertion namespace before policy runs. This prevents allocation under another writer's namespace, not impersonation of their session.

For a Board schema from [Collections](collections.md), verify the authenticated writer binding before submission:

```ts
import { assertClientBatchNamespace, decodeClientBatch } from "articollab";

// These values come from your transport and verified session binding.
const batch = decodeClientBatch(Board, JSON.parse(batchMessage));
assertClientBatchNamespace(batch, authenticatedWriterId);
const receipt = server.receive(batch);
```

Never derive `authenticatedWriterId` from the request body. Verify binding on retries too. A writer may still anchor insertions after another writer's elements or delete them; deletion authorization belongs to your application.

If you intentionally use custom incoming IDs, provide your own namespace policy and opt out:

```ts
const server = createServer(Board, { allowCustomClientNamespaces: true });
```

This option defaults to `false`, does not disable other validation, and must be supplied again on restore. Resolver-generated authoritative IDs are outside the incoming check.

To cancel a namespace-invalid original, verify its writer binding, then call `server.reject(batch)` without the standalone namespace helper. Rejection skips the server namespace check. Both entrypoints return the last identical result before checking new submissions, including a saved rejection or custom-ID acceptance.

A guard failure or runtime throw is not an acknowledgement. See the [exact namespace contract](reference.md#incoming-insertion-namespaces) and [upgrade guidance](recovery.md#upgrading-from-020-beta0).

## Deliver in order

Every client needs every authoritative commit, exactly once and in global sequence order. If its watermark is 10 and its own commit is 12, first deliver commit 11. Do not skip it because POST succeeded or because commit 12 belongs to that client.

For each new result:

1. Persist the server checkpoint if your application promises recovery.
2. Deliver the commit to every relevant client, including the source.
3. Finish that delivery before processing a listener's new submission.

Use an application-owned queue when listeners can submit during delivery. The small Counter example has no such listeners; it is not a production broadcast loop.

For a retained retry, do not broadcast again to peers. [Catch up the source](recovery.md#catch-up-before-resubmitting) from its watermark; skip results it has already consumed. `receipt.replayed` does not create a new commit or catch up other clients.

The core supplies neither a registry nor transport. See the [server contract](reference.md#server-policy-rejection-and-retries) for sequence and retry rules.

[Previous: Transactions](transactions.md) · [Next: Recovery](recovery.md)
