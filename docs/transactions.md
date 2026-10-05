# Transactions and events

Use a transaction when several synchronous edits should travel as one batch. Use document-level events to refresh a view, not to infer acknowledgements or save checkpoints.

## Batch related edits

```ts
const result = doc.transact(() => {
  doc.state.count.value = 1;
  doc.state.items.push("Draft");
  doc.state.body.insert(0, "Hello");
  return "done";
});
// result === "done"; one batch with three operations; one local change.
```

Outside a transaction, each actual mutation creates its own batch. An empty transaction creates none. Value assignment still records an operation when the value is unchanged.

Transactions are synchronous. Do not pass an async callback. An exception escaping the outer callback rolls back its visible mutations and does not consume a local batch sequence. Already allocated List/Text IDs are not reused.

## Nested calls have no savepoint

```ts
doc.transact(() => {
  doc.state.count.value = 1;
  try {
    doc.transact(() => {
      doc.state.count.value = 2;
      throw new Error("stop inner callback");
    });
  } catch {
    doc.state.count.value = 3;
  }
});
// One successful outer batch contains set(1), set(2), set(3).
```

The inner call joins the outer transaction. Catching its error does not undo its earlier operations. If the error escapes the outer callback, the outer transaction's uncommitted mutations are rolled back.

## Observe visible changes

```ts
const unsubscribe = doc.on("change", (event) => {
  console.log(event.origin, doc.state.count.value);
});
unsubscribe();
```

Local completion is optimistic state → pending/sequence → `onBatch` → local change. A synchronous `onBatch` may already deliver a server result before the local listener runs.

Server changes are emitted only when visible state or the replay-conflict descriptor changes. A normal own ack can be silent. Read `checkpoint()` after successful receive to track acknowledgement or persistence, including silent acks.

## Callback failure is not rollback

If `onBatch` throws, its batch is already pending; the local change is not emitted. If a listener throws, completed state/sequence advances remain and later listeners may not run. A server listener throws after receive has advanced state and watermark.

The core propagates these errors, but does not permanently disable the document. Transport examples stop their connection/network on the first error. Never interpret every thrown callback as “nothing happened.” See the [full event contract](reference.md#mutations-transactions-and-events).

[Previous: Collections](collections.md) · [Next: Server policy and wire](server-wire.md)
