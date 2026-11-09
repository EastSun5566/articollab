import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/**
 * Example-only bridge from a node:http request to a Fetch API handler. It streams the response
 * body chunk by chunk, which event streams need, and aborts the request when the client
 * disconnects, which closes them. Frameworks such as Hono do this for you.
 */
export function toNodeListener(handle: (request: Request) => Promise<Response>) {
  return (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    const disconnected = new AbortController();
    outgoing.once("close", () => { disconnected.abort(); });
    const request = new Request(new URL(incoming.url ?? "/", "http://127.0.0.1"), {
      method: incoming.method ?? "GET",
      signal: disconnected.signal,
      headers: Object.entries(incoming.headers).flatMap(([name, header]) =>
        header === undefined ? [] : (Array.isArray(header) ? header : [header]).map((entry): [string, string] => [name, entry])),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node:stream/web and the global ReadableStream are the same class with separate typings.
      ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream, duplex: "half" } : {}),
    });
    void handle(request).then(async (response) => {
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.flushHeaders();
      if (response.body === null) { outgoing.end(); return; }
      for await (const chunk of response.body) {
        if (outgoing.destroyed) break;
        outgoing.write(chunk);
      }
      outgoing.end();
    }).catch(() => { outgoing.destroy(); });
  };
}
