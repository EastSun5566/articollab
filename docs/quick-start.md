# Counter quick start

Use this example to see exactly when a local edit becomes authoritative. It buffers one batch, submits it manually, then delivers the commit to the writer and a peer.

## Version

These instructions target the published `0.2.0-beta.0`. The 0.1 betas use a different session/checkpoint contract; do not mix them. Use an ESM project (`"type": "module"`).

## Install and run

In an ESM project, use Node.js 24+ and install the matching version from npm. You do not need access to the private repository.

```sh
pnpm add articollab@0.2.0-beta.0
```

Save the following complete snippet as `counter.ts` in your project and run `node counter.ts`. Node runs this TypeScript example directly; no build step is needed. The import resolves the installed package's production ESM entrypoint.

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

`openClient()` issues one writer identity and reserves its server session. The two assignments take effect immediately and become **one batch with two operations**. `onBatch` only buffers that batch; it does not provide a built-in transport.

`server.receive(batch)` creates a receipt containing the authoritative commit. Deliver **the commit**, not the receipt, to every relevant client in global sequence order. At the writer, that commit also acknowledges its pending batch. The final value remains 3, so the own ack need not produce another change event.

This deliberately synchronous example has no reentrant listeners. A real broadcast loop must serialize delivery so listener-generated batches cannot interrupt an earlier commit; see the [examples guide](examples.md#in-memory-broadcast-walkthrough).

[Previous: Overview](README.md) · [Next: Concepts](concepts.md)
