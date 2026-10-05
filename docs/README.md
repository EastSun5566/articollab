# Articollab

Build collaborative state with ordinary typed collection methods. Clients see their edits immediately; a server decides the authoritative order, and clients replay work that has not been acknowledged.

Articollab is **not a CRDT**. It uses [articulated](https://github.com/mweidner037/articulated) for stable List/Text identities, while the server provides a single total order.

## Start small

Read the [Counter quick start](quick-start.md), then learn the [four stages of an edit](concepts.md). You do not need an HTTP server, editor framework or database to understand the core.

```ts
const Counter = defineDocument({ count: value(0) });
// After creating a client:
doc.state.count.value = 1;
// The client now displays 1. This alone does not update the server.
```

The complete runnable example is on the next page. Later pages introduce mixed collections, policy and recovery without hiding submission behind automatic networking.

## What is included?

Version `0.1.0-beta.0` includes Value/List/Text, synchronous transactions, optimistic reconciliation, policy/rejection, wire decoders, snapshots, checkpoints, last-batch retry and bounded catch-up.

The application owns transport, storage, authentication, writer coordination, document lineage and recovery orchestration. Examples demonstrate those responsibilities; they are not exported production adapters.

## Availability and compatibility

The first public beta is prepared but has **not been published to npm**. Until publication is confirmed, use a checkout or a locally packed tarball as described in the quick start. After confirmation, install with `pnpm add articollab@beta`. The source repository remains private; the npm package will be publicly downloadable.

Within `0.1.x`, the [README core contracts](reference.md#v01-notes-and-compatibility) and existing wire/checkpoint formats are the compatibility baseline. Example helpers are not part of that guarantee.

[Next: Counter quick start](quick-start.md)
