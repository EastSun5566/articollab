import type { ClientBatch, Operation, ServerCommit } from "../src/index.ts";

export function readHttpResponse(
  url: string, fetch: typeof globalThis.fetch, path: string, status: number, init?: RequestInit
): Promise<string>;

export function createHttpSyncController<O extends Operation>(options: {
  url: string;
  fetch: typeof globalThis.fetch;
  checkpoint: () => {
    snapshot: { serverSeq: number };
    lastLocalSeq: number;
    pendingBatches: readonly ClientBatch<O>[];
  };
  receive: (commit: ServerCommit<O>) => void;
  decodeCommit: (input: unknown) => ServerCommit<O>;
  isBlocked: () => boolean;
  saveClient: () => void;
}): {
  requireUsable(): void;
  stop(error: unknown): unknown;
  sync(): Promise<boolean>;
  rejectPending(): Promise<boolean>;
};
