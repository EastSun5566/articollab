# Concepts

An immediate local result is not the same as confirmed shared state. This page explains the distinction and why Articollab uses a server order and stable element identities.

## Why a server decides

The server is the authority for shared state. It orders batches and can apply application policy before deciding their effect. Every client then reconciles against the same ordered results.

Clients edit optimistically so a view does not wait for a network round trip. This gives responsive local editing, but an edit can later change or disappear if the server transforms or rejects it. Unlike a CRDT, this model relies on server commits rather than independent merging.

## Four stages of an edit

| Stage | What happens | What it does not prove |
| --- | --- | --- |
| Local mutation | Visible state changes and a pending batch is created. | The server has not necessarily seen it. |
| Submission | The application sends the original batch. | Sending, or an HTTP success response, is not an acknowledgement. |
| Authoritative commit | The server accepts, transforms or rejects the effect and assigns `serverSeq`. | Clients may not have received it yet. |
| Acknowledgement | The source receives the commit in order and removes its earliest pending batch. | It does not imply a change event or durable storage. |

In the [Counter example](quick-start.md), this assignment changes only the local view until the application submits its batch:

```ts
doc.state.count.value = 5;
// Visible: 5. The batch stays pending until its commit is received.
```

Keep the original batch while it is pending. Do not rewrite it when retrying or restoring.

## One order, two sequences

`seq` counts batches per client, starting at 1. `serverSeq` counts new authoritative commits across all clients, also starting at 1. A snapshot records the latest global sequence, called its watermark; initially it is 0.

```text
writer seq 1 → serverSeq 1
peer   seq 1 → serverSeq 2
writer seq 2 → serverSeq 3
```

A client must receive commits 1, 2, 3 in order, exactly once. Its own commit 3 cannot skip the peer's commit 2. An empty authoritative result still consumes a sequence and acknowledges a batch.

## Replay keeps unconfirmed edits visible

A client keeps authoritative state separately from pending batches. Its visible state is the authoritative state with the complete replayable pending prefix applied.

Suppose the authoritative count is 1 and you locally set it to 5:

| Received result | Authoritative count | Visible count |
| --- | --- | --- |
| No result yet | 1 | 5 |
| A peer sets count to 2 | 2 | 5 |
| The server rejects your pending write | 2 | 2 |

The peer's result changes the base, but your pending write still applies over it. Rejection removes that write, revealing the base.

Replay uses the recorded operations, not a rerun of your transaction callback. A pending `set(5)` stays `set(5)`; it is not an intent such as “increment the latest count.”

## Why List and Text use stable IDs

An index changes when another writer inserts or deletes before it. List/Text convert local indices to stable insertion anchors and deletion targets when you edit, so the operation still refers to the intended element during replay.

Deleted identities remain as tombstones: known deleted positions can still anchor an insertion. However, a rejected insertion was never authoritative. A later pending deletion targeting it may become [blocked](recovery.md#blocked-pending).

## Core and application responsibilities

The core provides collection semantics, sequence checks, reconciliation and checkpoint/decoder contracts. Your application supplies message delivery, storage, quotas, business validation, authentication and recovery decisions.

For example, an open client session reserves a writer identity. It does not authenticate the caller or prevent a second process from using that identity.

[Previous: Counter quick start](quick-start.md) · [Next: Collections](collections.md)
