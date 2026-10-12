# Articollab

Build collaborative state with typed collection methods. A client displays edits immediately; a server decides their shared order and authoritative result.

## When to use it

Use Articollab when you want a server to control shared state while clients remain responsive. Your application can accept, transform or reject a batch without changing the collection API.

Articollab is **not a CRDT**. Clients need ordered server commits to reconcile their work. It uses [articulated](https://github.com/mweidner037/articulated) for stable List/Text identities.

Start with the [Counter quick start](quick-start.md). It runs in memory so you can follow an edit from local state to server confirmation before adding networking.

## What you build with

- **Value** replaces an immutable JSON payload.
- **List** inserts and deletes elements with stable identities.
- **Text** edits plain text using Unicode code-point indices.
- **Transactions** group edits into one batch.
- **Policy, decoders and checkpoints** help you control submissions and recover unconfirmed work.

The [concepts guide](concepts.md) explains how these pieces work together. The [reference](reference.md) defines their exact contracts.

## What your application supplies

You choose the transport, storage, authentication and recovery workflow. You also coordinate one writer per client ID and ensure restored checkpoints belong to the same document.

Articollab provides the collaboration core, not an editor, database or production networking adapter. Read [FAQ and limitations](faq.md) before choosing an integration.

## Install

The library is available on npm:

```sh
pnpm add articollab
```

These docs describe the 0.2 API. Use an ESM project; the runnable Node.js examples require Node 24+. You do not need a repository checkout to use the package. Existing applications should read [upgrade guidance](recovery.md#upgrading-from-01) before mixing versions or checkpoints.

[Next: Counter quick start](quick-start.md)
