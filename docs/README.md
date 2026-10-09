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

The unpublished `0.2.0-beta.0` checkout includes Value/List/Text, synchronous transactions, optimistic reconciliation, policy/rejection, wire decoders, snapshots, checkpoints, last-batch retry and bounded catch-up.

The application owns transport, storage, authentication, writer coordination, document lineage and recovery orchestration. Examples demonstrate those responsibilities; they are not exported production adapters.

## Availability and compatibility

This checkout is not yet published. Build from source or install a matching local tarball; the npm beta may still use the incompatible 0.1 contract. The source repository remains private; repository access is needed for the development tools and examples.

The [0.2 breaking notes](reference.md#v02-notes-and-compatibility) describe explicit writer sessions and the new server checkpoint format. Example helpers are not package APIs.

[Next: Counter quick start](quick-start.md)
