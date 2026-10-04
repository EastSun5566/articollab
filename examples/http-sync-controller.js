// @ts-check

/**
 * @param {string} url
 * @param {typeof globalThis.fetch} fetch
 * @param {string} path
 * @param {number} status
 * @param {RequestInit} [init]
 */
export async function readHttpResponse(url, fetch, path, status, init) {
  const response = await fetch(new URL(path, url), init);
  const message = await response.text(); // Consume error responses too.
  if (response.status !== status) throw new Error("Unexpected HTTP status: " + response.status);
  return message;
}

/**
 * Example-only manual synchronization, independent of document class identity.
 * @template {import("../src/index.ts").Operation} O
 * @param {{
 *   url: string,
 *   fetch: typeof globalThis.fetch,
 *   checkpoint: () => {snapshot: {serverSeq: number}, lastLocalSeq: number,
 *     pendingBatches: readonly import("../src/index.ts").ClientBatch<O>[]},
 *   receive: (commit: import("../src/index.ts").ServerCommit<O>) => void,
 *   decodeCommit: (input: unknown) => import("../src/index.ts").ServerCommit<O>,
 *   isBlocked: () => boolean,
 *   saveClient: () => void
 * }} options
 */
export function createHttpSyncController(options) {
  const fetch = options.fetch; // Native browser fetch must not be bound to the options object.
  let failed = false;
  /** @type {unknown} */
  let failure;
  let busy = false;
  let missingHistory = false;
  function requireUsable() { if (failed) throw failure; }
  /** @param {unknown} error */
  function stop(error) {
    if (!failed) { failed = true; failure = error; }
    return failure;
  }
  /** @param {string} path @param {number} status @param {RequestInit} [init] */
  async function request(path, status, init) {
    requireUsable();
    // Check usability before HTTP status: an in-flight local save failure wins.
    const response = await fetch(new URL(path, options.url), init);
    const message = await response.text();
    requireUsable();
    if (response.status !== status) throw new Error("Unexpected HTTP status: " + response.status);
    return message;
  }

  async function catchUp() {
    const watermark = options.checkpoint().snapshot.serverSeq;
    /** @type {unknown} */
    const input = JSON.parse(await request("/commits?since=" + watermark, 200));
    if (input === null) { missingHistory = true; return false; }
    if (!Array.isArray(input)) throw new Error("Expected a commit array or null");
    const commits = input.map((entry) => options.decodeCommit(entry));
    for (const [index, commit] of commits.entries()) {
      if (commit.serverSeq !== watermark + index + 1) {
        throw new Error("Catch-up commits must be consecutive and ordered");
      }
    }
    // Validate the whole prefix first; never sort, skip, or repair a response.
    for (const commit of commits) {
      requireUsable();
      options.receive(commit);
      options.saveClient(); // Own acknowledgements need not emit a change.
    }
    return true;
  }

  /** @param {boolean} rejectPending */
  async function synchronize(rejectPending) {
    requireUsable();
    const action = rejectPending ? "rejectPending" : "sync";
    if (busy) throw new Error("Cannot call " + action + "() concurrently or reentrantly");
    if (missingHistory) return false;
    busy = true;
    try {
      // Capture before the first await; listener-created batches are not targets.
      const cutoff = rejectPending ? options.checkpoint().lastLocalSeq : undefined;
      if (!(await catchUp())) return false;
      while (true) {
        requireUsable();
        if (!rejectPending && options.isBlocked()) return false;
        const batch = options.checkpoint().pendingBatches[0];
        if (batch === undefined || (cutoff !== undefined && batch.seq > cutoff)) return true;
        await request(rejectPending ? "/rejections" : "/batches", 204, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch),
        });
        if (!(await catchUp())) return false;
        if (options.checkpoint().pendingBatches[0]?.seq === batch.seq) {
          throw new Error((rejectPending ? "Rejection" : "Submission") +
            " completed without acknowledging the pending batch");
        }
      }
    } catch (error) {
      throw stop(error);
    } finally {
      busy = false;
    }
  }

  return { requireUsable, stop,
    sync() { return synchronize(false); },
    rejectPending() { return synchronize(true); },
  };
}
