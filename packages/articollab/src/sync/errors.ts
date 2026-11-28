import { isJsonObject } from "../json.ts";

export const WATERMARK_AHEAD = "watermark_ahead";
export const WATERMARK_AHEAD_MESSAGE = "Catch-up watermark is ahead of the server";

/** A sync request answered with an unexpected status, over HTTP or a WebSocket. */
export class SyncRequestError extends Error {
  readonly status: number;
  /** Timeouts, rate limits and server errors may succeed later; other statuses will not. */
  readonly retryable: boolean;

  /** Present when the server identifies the checkpoint as ahead of its sequence. */
  readonly code: typeof WATERMARK_AHEAD | undefined;

  constructor(status: number, code?: typeof WATERMARK_AHEAD) {
    super(code === WATERMARK_AHEAD ? WATERMARK_AHEAD_MESSAGE : `Sync request failed with status ${status}`);
    this.code = code;
    this.name = "SyncRequestError";
    this.status = status;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

/** Interprets the known diagnostic and leaves other error bodies opaque. */
export function syncRequestError(status: number, body: unknown): SyncRequestError {
  const code = status === 409 && isJsonObject(body) && body.code === WATERMARK_AHEAD ? WATERMARK_AHEAD : undefined;
  return new SyncRequestError(status, code);
}

/** A response that is not the expected JSON. Retrying cannot repair it. */
export class SyncResponseError extends Error {
  readonly retryable = false;
}
