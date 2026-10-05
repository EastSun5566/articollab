# Concepts

Use these terms to separate the immediate UI result from confirmed shared state. They apply whether messages travel through a function call, HTTP or another transport.

## Four stages of an edit

| Stage | What happens | What it does not prove |
| --- | --- | --- |
| Local mutation | Collection state changes optimistically; a pending batch is created. | The server has not necessarily seen it. |
| Submission | The application sends the original batch to the server. | Sending, or an HTTP success response, is not a client ack. |
| Authoritative commit | The server accepts, transforms or rejects the effect and assigns `serverSeq`. | Clients may not have received it yet. |
| Acknowledgement | The source client receives that commit in order and removes its earliest pending batch. | It does not imply a change event or durable storage. |

```ts
doc.state.count.value = 5;
// Visible: 5; pending: [{ clientId, seq: 1, operations: [...] }].
// Keep the original batch until its authoritative commit is received.
```

## Two sequences, one server order

`seq` is per client, starting at 1. `serverSeq` is global, starting at 1. A snapshot records the latest global watermark, initially 0.

```text
writer seq 1 → serverSeq 1
peer   seq 1 → serverSeq 2
writer seq 2 → serverSeq 3
```

Clients must receive commits 1, 2, 3 exactly once and in order. They cannot apply their own commit 3 before missing commit 2. Each successful new server batch consumes a global sequence, even if its authoritative operations are empty.

## Authoritative state plus pending replay

The visible state is authoritative state with the replayable pending batch prefix applied. A remote commit can change the authoritative base without erasing a still-pending local write.

For example, authoritative count 1 plus pending `set(5)` displays 5. A remote `set(2)` changes the base to 2, but replay still displays 5. If the server rejects the pending write, its empty commit removes that batch and the client displays 2.

List/Text operations refer to stable IDs rather than mutable indices. A rejected insertion can invalidate later pending dependencies; the client retains that work and reports a [replay conflict](recovery.md#blocked-pending).

## Who owns what?

The package owns collection semantics, ordering checks, reconciliation and typed checkpoint/decoder contracts. The application owns delivery queues, network errors, persistence barriers, quotas, business validation, authentication and recovery choices.

[Previous: Counter quick start](quick-start.md) · [Next: Collections](collections.md)
