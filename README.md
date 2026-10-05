# Articollab

Typed, server-authoritative collaborative collections for TypeScript, powered by [articulated](https://github.com/mweidner037/articulated).

Clients edit optimistically; the server orders commits and clients replay unacknowledged work. **Not a CRDT.** Includes Value, List and Unicode Text, transactions, server policy, wire decoding, checkpoints and catch-up. Your application supplies transport, storage and authentication.

## Install

The first beta, `0.1.0-beta.0`, is [available on npm](https://www.npmjs.com/package/articollab). Use an ESM project; the Node.js examples require Node 24+.

```sh
pnpm add articollab@beta
```

## Quick start

A single client and server, connected in memory:

```ts
import { createClient, createServer, defineDocument, value } from "articollab";

const Counter = defineDocument({ count: value(0) });
const server = createServer(Counter);
const doc = createClient(Counter, {
  clientId: "client-1",
  onBatch(batch) {
    doc.receive(server.receive(batch).commit);
  },
});

doc.state.count.value = 1;
console.log(doc.state.count.value); // 1
```

This example submits and acknowledges each batch synchronously. For multiple clients, deliver commits to every client in server order; see the walkthroughs below.

## Documentation

- [Counter walkthrough](docs/quick-start.md)
- [API, core contracts and compatibility](docs/reference.md)
- [Recovery](docs/recovery.md)
- [Examples](examples/README.md)
- [Development](docs/development.md)

The source repository is currently private, so the full documentation requires repository access. Example helpers are not package APIs or production adapters.

## License

MIT.
