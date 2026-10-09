# Articollab

Typed, server-authoritative collaborative collections for TypeScript, powered by [articulated](https://github.com/mweidner037/articulated).

Clients edit optimistically; the server orders commits and clients replay unacknowledged work. **Not a CRDT.** Includes Value, List and Unicode Text, transactions, server policy, wire decoding, checkpoints and catch-up. Your application supplies transport, storage and authentication.

## Install

**`0.2.0-beta.0` is published on [npm](https://www.npmjs.com/package/articollab)**, with explicit server-issued writer sessions and a new server checkpoint format. Use an ESM project (`"type": "module"`); the Node.js examples require Node 24+. Do not mix 0.1 servers/checkpoints with the 0.2 contract.

```sh
pnpm add articollab@0.2.0-beta.0
```

## Quick start

A single client and server, connected in memory:

```ts
import { createClient, createServer, defineDocument, value } from "articollab";

const Counter = defineDocument({ count: value(0) });
const server = createServer(Counter);
const doc = createClient(Counter, {
  clientId: server.openClient(),
  onBatch(batch) {
    doc.receive(server.receive(batch).commit);
  },
});

doc.state.count.value = 1;
console.log(doc.state.count.value); // 1
```

The server opens a writer session before its first batch. Disconnecting preserves that session; `server.closeClient(id)` permanently retires it. This example submits and acknowledges each batch synchronously. For multiple clients, deliver commits to every client in server order; see the walkthroughs below.

## Documentation

- [Counter walkthrough](docs/quick-start.md)
- [API, core contracts and compatibility](docs/reference.md)
- [Recovery](docs/recovery.md)
- [Examples](examples/README.md)
- [Development](docs/development.md)

The source repository is currently private, so the full documentation requires repository access. Example helpers are not package APIs or production adapters.

## License

MIT.
