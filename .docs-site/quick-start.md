# Quick start

Follow one batch from an optimistic edit to a commit shared by two clients.

## Before you start

Use Node.js 24 or later and an ESM project (`"type": "module"`).

## Install and run

Install from npm:

```sh
pnpm add articollab
```

Save this example as `score.ts` and run `node score.ts`.

<!-- checked-quick-start:start -->
```ts
import {
  createClient, createServer, defineDocument, value,
  type ClientBatch, type DocumentOperation,
} from "articollab";

const Score = defineDocument({ points: value(0) });
type Batch = ClientBatch<DocumentOperation<typeof Score.definition>>;
const outgoing: Batch[] = [];
const server = createServer(Score);
const doc = createClient(Score, {
  clientId: server.openClient(),
  onBatch: (batch) => { outgoing.push(batch); },
});
const peer = createClient(Score, { clientId: server.openClient(), onBatch() {} });

doc.transact(() => {
  doc.state.points.value = 2;
  doc.state.points.value = 3;
});
console.log("Optimistic:", doc.state.points.value);
console.log("Server before submission:", server.snapshot().data.points);

const batch = outgoing.shift();
if (batch === undefined) throw new Error("Expected one transaction batch");
const { commit } = server.receive(batch);
doc.receive(commit);
peer.receive(commit);

console.log("Server commit:", commit.serverSeq);
console.log("Confirmed:", doc.state.points.value);
console.log("Peer:", peer.state.points.value);
console.log("Pending:", doc.checkpoint().pendingBatches.length);
```
<!-- checked-quick-start:end -->

Expected output:

```text
Optimistic: 3
Server before submission: 0
Server commit: 1
Confirmed: 3
Peer: 3
Pending: 0
```

## Follow the data

`openClient()` opens a writer session. The two assignments take effect immediately and produce one batch. This example queues the batch in `onBatch`.

`server.receive(batch)` returns a receipt. Deliver its `commit` to each client in server order. At the writer, receiving the commit clears its pending batch. The visible score stays at `3`.

A Value keeps the number you set, so it suits a score one writer owns. When several writers add to the same number, use a [Counter](collections.md#counter-additions-that-all-count): it records additions, so they all count.

When listeners submit new work, [finish delivering the current commit first](server-wire.md#deliver-in-order).

[Previous: Overview](README.md) · [Next: Concepts](concepts.md)
