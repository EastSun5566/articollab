import type { ClientBatch } from "../index.ts";
import type { SyncTransport } from "./client.ts";

/** An unexpected HTTP status from a sync endpoint. */
export class SyncHttpError extends Error {
  readonly status: number;
  /** Timeouts, rate limits and server errors may succeed later; other statuses will not. */
  readonly retryable: boolean;

  constructor(status: number) {
    super(`Unexpected HTTP status: ${status}`);
    this.name = "SyncHttpError";
    this.status = status;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

/** A response that is not the expected JSON. Retrying cannot repair it. */
class SyncResponseError extends Error {
  readonly retryable = false;
}

export interface HttpTransportOptions {
  /** Base URL of the sync handler; `clients`, `batches`, `rejections` and `commits` resolve under it. */
  readonly url: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  /** Extra request headers, such as authorization, read before every request. */
  readonly headers?: () => HeadersInit | Promise<HeadersInit>;
}

function parse(message: string, what: string): unknown {
  try { return JSON.parse(message); }
  catch (cause) { throw new SyncResponseError(`Invalid ${what} JSON`, { cause }); }
}

/** HTTP transport for `connectSync`, matching the routes of `createSyncHandler`. */
export function createHttpTransport(options: HttpTransportOptions): SyncTransport {
  const base = new URL(options.url);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  // Read once: a native fetch must not be called as a method of the options object.
  const fetch = options.fetch ?? globalThis.fetch;

  async function request(path: string, status: number, init: RequestInit = {}): Promise<string> {
    const headers = new Headers(await options.headers?.());
    new Headers(init.headers).forEach((value, name) => { headers.set(name, value); });
    const response = await fetch(new URL(path, base), { ...init, headers });
    const message = await response.text(); // Consume every body, including errors.
    if (response.status !== status) throw new SyncHttpError(response.status);
    return message;
  }
  const post = (path: string, status: number, body: unknown) =>
    request(path, status, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  return {
    async register() {
      const input = parse(await post("clients", 201, {}), "registration");
      if (input === null || typeof input !== "object" || Array.isArray(input) ||
        !("clientId" in input) || typeof input.clientId !== "string" || !("snapshot" in input)) {
        throw new SyncResponseError("Invalid registration response");
      }
      return { clientId: input.clientId, snapshot: input.snapshot };
    },
    async submit(batch: ClientBatch) { await post("batches", 204, batch); },
    async reject(batch: ClientBatch) { await post("rejections", 204, batch); },
    async commitsSince(watermark: number) {
      return parse(await request(`commits?since=${watermark}`, 200), "catch-up");
    },
  };
}
