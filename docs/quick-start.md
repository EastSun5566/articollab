# Counter quick start

Use this example to see exactly when a local edit becomes authoritative. It buffers one batch, submits it manually, then delivers the commit to the writer and a peer.

## Before you start

Use Node.js 24+ and an ESM project (`"type": "module"`). The package is public; no repository checkout is required. For existing applications, read the [upgrade guidance](recovery.md#upgrading-from-01) before mixing servers or checkpoints.

## Install and run

Install from npm:

```sh
pnpm add articollab
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

This synchronous example has no listener-generated edits. When integrating multiple writers, finish delivering each commit before handling a listener's new submission. See [ordered delivery](server-wire.md#deliver-in-order).

[Previous: Overview](README.md) · [Next: Concepts](concepts.md)
