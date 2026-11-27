/** A sync request answered with an unexpected status, over HTTP or a WebSocket. */
export class SyncRequestError extends Error {
  readonly status: number;
  /** Timeouts, rate limits and server errors may succeed later; other statuses will not. */
  readonly retryable: boolean;

  constructor(status: number) {
    super(`Sync request failed with status ${status}`);
    this.name = "SyncRequestError";
    this.status = status;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

/** A response that is not the expected JSON. Retrying cannot repair it. */
export class SyncResponseError extends Error {
  readonly retryable = false;
}
