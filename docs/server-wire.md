# Server policy and wire data

Use policy to decide a batch's authoritative effect, and decoders to validate untrusted parsed JSON before calling typed runtime methods. These are separate boundaries.

## Accept, transform or reject

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

This Counter-only resolver caps accepted values at 10 and rejects later batches once the pre-batch count reaches 10. It returns operations synchronously; it does not send messages. Policy can return any valid operation set, not necessarily one operation per input.

`[]` produces a normal authoritative commit with no effect. Delivering it acknowledges the source batch and rolls back its optimistic effect. `server.reject(originalBatch)` explicitly does the same without running the resolver or applying the incoming operations.

The same last-batch retry returns its original result across `receive()` and `reject()`. Acceptance cannot later become rejection. Cancellation is not undo.

Resolver failures or invalid output do not advance server state/sequences. Policy side effects cannot be rolled back: keep decisions pure. For Text transformations reusing incoming IDs, preserve code-point length; different-length insertions need application-owned globally unique ranges.

## Decode at the transport boundary

```ts
const batch = decodeClientBatch(Counter, JSON.parse(batchMessage));
const { commit } = server.receive(batch);
const commitMessage = JSON.stringify(commit);
doc.receive(decodeServerCommit(Counter, JSON.parse(commitMessage)));
```

`JSON.parse()` is the application's job. The decoder accepts `unknown`, checks exact fields, paths, collection kinds, JSON payloads, sequences and IDs, then deeply copies/freezes the result. `WireDecodeError.path` is a JSON Pointer, such as `/operations/0/id/counter`.

Decoders do not infer a business object's shape from TypeScript `T`. Validate that separately. An operation with a structurally valid but unknown anchor may decode successfully, then fail runtime application atomically.

## Optionally guard insertion namespaces

Use the namespace helper when incoming clients should only allocate IDs in the package's standard writer/collection namespace:

```ts
import { assertClientBatchNamespace, decodeClientBatch } from "articollab";

// authenticatedWriterId comes from your verified writer/session binding.
const batch = decodeClientBatch(Board, JSON.parse(batchMessage));
assertClientBatchNamespace(batch, authenticatedWriterId);
const receipt = server.receive(batch);
```

A writer cannot allocate another writer's new IDs, but may still insert after or delete their existing elements. The helper checks exact canonical bunch IDs, not string prefixes, and returns `undefined` or throws `TypeError`. Guard retries too. It does not authenticate the caller or provide deletion authorization; every client ID must still have only one writer.

The check is opt-in and only covers the incoming batch, not resolver-generated IDs. Custom incoming namespaces may use a different application policy. To explicitly reject a namespace-invalid batch, first verify that `batch.clientId` matches the authenticated writer, then call `server.reject(batch)` without the namespace check. Neither a guard failure nor a thrown runtime error is an ack.

See the [namespace contract](reference.md#opt-in-insertion-namespaces) for the exact format and boundaries.

## Deliver in order

```ts
const receipt = server.receive(batch);
// New result: broadcast receipt.commit to all relevant clients.
// Retry: route its retained commit only to the source still missing it,
// after earlier missing commits. Never redeliver consumed commits.
```

Every client needs every authoritative commit in global order. Receipt `replayed` is routing metadata, not part of the commit wire object. The core does not supply a connection registry or broadcast queue.

See the [server contracts](reference.md#server-policy-rejection-and-retries) and [wire boundary](reference.md#wire-validation-and-error-boundaries).

[Previous: Transactions](transactions.md) · [Next: Recovery](recovery.md)
