import {
  createClient,
  decodeServerCommit,
  decodeSnapshot,
  type ClientBatch,
  type ClientCheckpoint,
  type ClientDocument,
  type DocumentOperation,
  type DocumentSchema,
  type SchemaShape,
  type ServerCommit,
} from "../index.ts";

/**
 * The network operations a sync client needs. Each method resolves when the request completed;
 * a submission that resolves is not yet an acknowledgement. Throw an error with
 * `retryable: false` for failures that must not be retried, such as an authorization error.
 */
export interface SyncTransport {
  /** Opens a new writer session and returns its ID with an encoded snapshot. */
  register(): Promise<{ readonly clientId: string; readonly snapshot: unknown }>;
  submit(batch: ClientBatch): Promise<void>;
  reject(batch: ClientBatch): Promise<void>;
  /** Parsed JSON: the commits after `watermark`, or null when history no longer covers them. */
  commitsSince(watermark: number): Promise<unknown>;
}

export type SyncStatus = "idle" | "syncing" | "retrying" | "blocked" | "gap" | "stopped" | "failed";

export interface SyncRetryOptions {
  /** Delay before the first retry, in milliseconds. Default 500. */
  readonly initialDelay?: number;
  /** Upper bound for the exponentially growing delay, in milliseconds. Default 30000. */
  readonly maxDelay?: number;
}

export interface ConnectSyncOptions<S extends SchemaShape> {
  readonly transport: SyncTransport;
  /** Resume this writer. Without it, a new session is registered. */
  readonly checkpoint?: ClientCheckpoint<S>;
  /** Persists the checkpoint before pending work is sent and after commits are received. */
  readonly save?: (checkpoint: ClientCheckpoint<S>) => void | Promise<void>;
  /** Milliseconds between catch-up polls while idle or blocked. Default 1000; 0 disables polling. */
  readonly pollInterval?: number;
  readonly retry?: SyncRetryOptions;
}

export interface SyncClient<S extends SchemaShape> {
  readonly doc: ClientDocument<S>;
  readonly status: SyncStatus;
  /** Why the client failed, while `status` is "failed". */
  readonly error: unknown;
  /** Catches up and submits pending work now; true when everything pending was acknowledged. */
  sync(): Promise<boolean>;
  /** Confirms cancellation of the pending batches that exist when it is called. */
  rejectPending(): Promise<boolean>;
  /** After a history gap with no pending work, registers a new session and stops this client. */
  restartFromSnapshot(): Promise<SyncClient<S>>;
  on(event: "status", listener: (status: SyncStatus) => void): () => void;
  /** Stops polling and retries. Responses that arrive later are ignored. */
  stop(): void;
}

class StoppedSignal extends Error {}

/** A protocol violation or local failure: never retried. */
class SyncFailure extends Error {
  readonly retryable = false;
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof StoppedSignal) &&
    !(typeof error === "object" && error !== null && "retryable" in error && error.retryable === false);
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

/**
 * Creates or restores a document and keeps it synchronized through `transport`.
 * The client owns the document's `onBatch`: local edits are scheduled for submission automatically.
 */
export async function connectSync<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  options: ConnectSyncOptions<S>
): Promise<SyncClient<S>> {
  const pollInterval = nonNegativeInteger(options.pollInterval ?? 1000, "pollInterval");
  const initialDelay = nonNegativeInteger(options.retry?.initialDelay ?? 500, "retry.initialDelay");
  const maxDelay = nonNegativeInteger(options.retry?.maxDelay ?? 30_000, "retry.maxDelay");
  const { transport, save } = options;

  let doc: ClientDocument<S> | undefined;
  let status: SyncStatus = "idle";
  let error: unknown;
  let running: Promise<boolean> | undefined;
  let rerun = false;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let savedVersion = "";
  const listeners = new Set<(status: SyncStatus) => void>();

  const onBatch = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (status !== "stopped" && status !== "failed" && status !== "gap") void sync().catch(() => {});
    });
  };
  if (options.checkpoint !== undefined) {
    doc = createClient(schema, { clientId: options.checkpoint.clientId, checkpoint: options.checkpoint, onBatch });
  } else {
    const registration = await transport.register();
    doc = createClient(schema, {
      clientId: registration.clientId, snapshot: decodeSnapshot(schema, registration.snapshot), onBatch,
    });
  }
  const document = doc;

  function setStatus(next: SyncStatus): void {
    if (status === next) return;
    status = next;
    let thrown: { readonly cause: unknown } | undefined;
    for (const listener of [...listeners]) {
      try { listener(next); } catch (cause) { thrown ??= { cause }; }
    }
    // A listener failure is an application bug, not a network condition: never retry it.
    if (thrown !== undefined && next !== "failed") fail(new SyncFailure("A status listener threw", thrown));
  }
  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function fail(cause: unknown): never {
    if (status !== "failed") {
      error = cause;
      clearTimer();
      setStatus("failed");
    }
    throw error;
  }
  function usable(): void {
    if (status === "stopped") throw new StoppedSignal("Sync client is stopped");
    if (status === "failed") throw error;
  }
  function schedule(delay: number): void {
    clearTimer();
    timer = setTimeout(() => { timer = undefined; void sync().catch(() => {}); }, delay);
  }

  /** Saves when pending work or the watermark changed since the last save. */
  async function persist(): Promise<void> {
    if (save === undefined) return;
    const checkpoint = document.checkpoint();
    const version = `${checkpoint.lastLocalSeq}:${checkpoint.snapshot.serverSeq}`;
    if (version === savedVersion) return;
    try { await save(checkpoint); }
    catch (cause) { fail(cause); }
    usable();
    savedVersion = version;
  }

  /** Applies every missing commit in order; false when history no longer covers the watermark. */
  async function catchUp(): Promise<boolean> {
    const watermark = document.checkpoint().snapshot.serverSeq;
    const input = await transport.commitsSince(watermark);
    usable();
    if (input === null) return false;
    if (!Array.isArray(input)) throw new SyncFailure("Expected a commit array or null");
    let commits: ServerCommit<DocumentOperation<S>>[];
    try { commits = input.map((entry) => decodeServerCommit(schema, entry)); }
    catch (cause) { throw new SyncFailure("Invalid commit in catch-up response", { cause }); }
    // Validate the whole response before applying any of it; never reorder or skip.
    for (const [index, commit] of commits.entries()) {
      if (commit.serverSeq !== watermark + index + 1) throw new SyncFailure("Catch-up commits must be consecutive");
    }
    for (const commit of commits) document.receive(commit);
    await persist();
    return true;
  }

  async function pass(): Promise<boolean> {
    setStatus("syncing");
    await persist();
    if (!(await catchUp())) { clearTimer(); setStatus("gap"); return false; }
    while (true) {
      usable();
      const batch = document.checkpoint().pendingBatches[0];
      // Work created before this check is sent by this pass; only later work needs a rerun.
      if (batch === undefined) { rerun = false; setStatus("idle"); return true; }
      // Batches before the conflicting one still replay; send them, then wait.
      if (document.replayConflict?.batch.seq === batch.seq) { setStatus("blocked"); return false; }
      await persist();
      await transport.submit(batch);
      usable();
      if (!(await catchUp())) { clearTimer(); setStatus("gap"); return false; }
      if (document.checkpoint().pendingBatches[0]?.seq === batch.seq) {
        throw new SyncFailure("Submission completed without acknowledging the pending batch");
      }
    }
  }

  /** Runs `work` after any running pass; callers that join share its promise. */
  function exclusive(work: () => Promise<boolean>): Promise<boolean> {
    const previous = running;
    let current: Promise<boolean> | undefined;
    current = (async () => {
      if (previous !== undefined) await previous.catch(() => {});
      try { return await work(); }
      finally {
        // Cleared before callers resume, so a later sync() never joins a finished pass.
        if (running === current) running = undefined;
        // A sync() that joined after the final pending check would otherwise be lost. A retry
        // already scheduled will send that work; rerunning now would bypass the backoff.
        if (rerun && status === "idle") { rerun = false; onBatch(); }
      }
    })();
    running = current;
    return current;
  }

  async function runSync(): Promise<boolean> {
    try {
      let done: boolean;
      do { rerun = false; done = await pass(); } while (done && rerun);
      attempt = 0;
      if (pollInterval > 0 && (status === "idle" || status === "blocked")) schedule(pollInterval);
      return done;
    } catch (cause) {
      if (cause instanceof StoppedSignal) return false;
      if (status === "failed" || !isRetryable(cause)) fail(cause);
      // Transport errors leave the outcome unknown; the next pass catches up before resending.
      const delay = Math.min(maxDelay, initialDelay * 2 ** attempt);
      attempt = Math.min(attempt + 1, 52);
      setStatus("retrying");
      schedule(delay / 2 + Math.random() * (delay / 2));
      return false;
    }
  }

  function sync(): Promise<boolean> {
    try { usable(); } catch (cause) { return Promise.reject(cause); }
    if (running !== undefined) { rerun = true; return running; }
    clearTimer();
    return exclusive(runSync);
  }

  async function rejectPending(): Promise<boolean> {
    usable();
    clearTimer();
    return exclusive(async () => {
      try {
        // Capture before the first await: listener-created batches are not targets.
        const cutoff = document.checkpoint().lastLocalSeq;
        setStatus("syncing");
        await persist();
        if (!(await catchUp())) { setStatus("gap"); return false; }
        while (true) {
          usable();
          const batch = document.checkpoint().pendingBatches[0];
          if (batch === undefined || batch.seq > cutoff) break;
          await transport.reject(batch);
          usable();
          if (!(await catchUp())) { setStatus("gap"); return false; }
          if (document.checkpoint().pendingBatches[0]?.seq === batch.seq) {
            throw new SyncFailure("Rejection completed without acknowledging the pending batch");
          }
        }
        setStatus(document.replayConflict === null ? "idle" : "blocked");
        // Batches created after the cutoff are ordinary pending work.
        if (document.checkpoint().pendingBatches.length > 0) rerun = true;
        else if (pollInterval > 0) schedule(pollInterval);
        return true;
      } catch (cause) {
        if (cause instanceof StoppedSignal) return false;
        if (status === "failed" || !isRetryable(cause)) fail(cause);
        // A transport error leaves the outcome unknown; the caller may retry rejectPending().
        setStatus("idle");
        if (pollInterval > 0) schedule(pollInterval);
        throw cause;
      }
    });
  }

  const client: SyncClient<S> = {
    doc: document,
    get status() { return status; },
    get error() { return error; },
    sync,
    rejectPending,
    async restartFromSnapshot() {
      if (status !== "gap") throw new Error("restartFromSnapshot() requires a history gap");
      if (document.checkpoint().pendingBatches.length > 0) {
        throw new Error("restartFromSnapshot() would discard pending work; preserve the checkpoint instead");
      }
      const { transport: nextTransport, save: nextSave, pollInterval: nextPoll, retry } = options;
      const next = await connectSync(schema, {
        transport: nextTransport,
        ...(nextSave === undefined ? {} : { save: nextSave }),
        ...(nextPoll === undefined ? {} : { pollInterval: nextPoll }),
        ...(retry === undefined ? {} : { retry }),
      });
      client.stop();
      return next;
    },
    on(event, listener) {
      if (event !== "status") throw new Error(`Unknown event: ${event as string}`);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    stop() {
      if (status === "stopped") return;
      clearTimer();
      if (status !== "failed") setStatus("stopped");
    },
  };

  await persist();
  if (document.checkpoint().pendingBatches.length > 0) onBatch();
  else if (pollInterval > 0) schedule(0);
  return client;
}
