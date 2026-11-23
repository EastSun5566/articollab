# Articollab

Articollab is a TypeScript library for collaborative state. Clients show edits immediately. The server orders commits and decides their effect.

## Install

Use Node.js 24 or later and an ESM project (`"type": "module"`).

```sh
pnpm add articollab
```

## Quick start

Save this example as `counter.ts` and run `node counter.ts`.

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

The example opens a writer session, submits one edit and delivers the server commit back to the writer. It prints `1`.

## Documentation

- [Follow an edit from client to server](docs/quick-start.md)
- [Connect clients over HTTP or WebSocket](docs/sync.md)
- [Read the API reference](docs/reference.md)

Visit the [documentation site](https://eastsun5566.github.io/articollab/) or read the [contributor guide](CONTRIBUTING.md).

## License

[MIT](LICENSE). Articollab uses [articulated](https://github.com/mweidner037/articulated) for stable List and Text identities.
