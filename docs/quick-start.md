# Counter quick start

Follow one batch from an optimistic edit to a commit shared by two clients.

## Before you start

Use Node.js 24 or later and an ESM project (`"type": "module"`).

## Install and run

Install from npm:

```sh
pnpm add articollab
```

Save this example as `counter.ts` and run `node counter.ts`.

<!-- checked-counter:start -->
```ts
import {
  createClient, createServer, defineDocument, value,
  type ClientBatch, type DocumentOperation,
} from "articollab";

const Counter = defineDocument({ count: value(0) });
type Batch = ClientBatch<DocumentOperation<typeof Counter.definition>>;
const outgoing: Batch[] = [];
const server = createServer(Counter);
const doc = createClient(Counter, {
  clientId: server.openClient(),
  onBatch: (batch) => { outgoing.push(batch); },
});
const peer = createClient(Counter, { clientId: server.openClient(), onBatch() {} });

doc.transact(() => {
  doc.state.count.value = 2;
  doc.state.count.value = 3;
});
console.log("Optimistic:", doc.state.count.value);
console.log("Server before submission:", server.snapshot().data.count);

const batch = outgoing.shift();
if (batch === undefined) throw new Error("Expected one transaction batch");
const { commit } = server.receive(batch);
doc.receive(commit);
peer.receive(commit);

console.log("Server commit:", commit.serverSeq);
console.log("Confirmed:", doc.state.count.value);
console.log("Peer:", peer.state.count.value);
console.log("Pending:", doc.checkpoint().pendingBatches.length);
```
<!-- checked-counter:end -->

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

`server.receive(batch)` returns a receipt. Deliver its `commit` to each client in server order. At the writer, receiving the commit clears its pending batch. The visible count stays at `3`.

A Value records the number you set, so this example suits a count one writer owns. When several writers increment the same count, use a [Counter](collections.md#counter-additions-that-all-count), which records additions instead.

When listeners submit new work, [finish delivering the current commit first](server-wire.md#deliver-in-order).

[Previous: Overview](README.md) · [Next: Concepts](concepts.md)
