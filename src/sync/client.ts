import {
  createClient,
  decodeClientCheckpoint,
  decodeServerCommit,
  decodeSnapshot,
  type ClientBatch,
  type ClientCheckpoint,
  type ClientDocument,
  type DocumentOperation,
  type DocumentSchema,
  type JsonValue,
  type SchemaShape,
  type ServerCommit,
} from "../index.ts";
import { readClientProgress } from "../runtime.ts";
import { integerOption } from "../options.ts";
import { createPresence, type PresenceController, type SyncPresenceOptions, type SyncPresence } from "./presence.ts";
import type { CheckpointStore } from "./store.ts";

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
  /**
   * Optional push channel: delivers commits after `watermark` as the server saves them until the
   * returned function closes it. Without it the client polls.
   */
  subscribe?(watermark: number, handlers: SyncSubscription): () => void;
  /** Optional presence: shares a writer's ephemeral state, or null to leave. Needed for `presence`. */
  publishPresence?(clientId: string, state: JsonValue | null): Promise<void>;
}

/** Callbacks a transport's push channel reports to. */
export interface SyncSubscription {
  /** The channel is connected. */
  onOpen(): void;
  /** Parsed JSON commits, normally the ones after the last delivered. */
  onCommits(commits: unknown): void;
  /** History no longer covers the watermark; the channel ends after this. */
  onGap(): void;
  /** Parsed JSON `{ clientId, state }`: one writer's presence, or its departure with a null state. */
  onPresence?(update: unknown): void;
  /** Any traffic, including heartbeats; proves the channel is alive. */
  onActivity(): void;
  /** The channel ended, with the reason when it failed. */
  onEnd(error?: unknown): void;
}

export type SyncStatus = "idle" | "syncing" | "retrying" | "blocked" | "gap" | "closed" | "failed";

/** The push channel: closed, opening, or delivering commits (polling pauses while open). */
export type SyncPushState = "off" | "connecting" | "open";

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
  /**
   * Persists the checkpoint after every local edit, before pending work is sent and after commits
   * are received. Saves run one at a time and always save the latest checkpoint.
   */
  readonly save?: (checkpoint: ClientCheckpoint<S>) => void | Promise<void>;
  /**
   * Loads, saves and closes this writer's checkpoint: a saved checkpoint is restored, otherwise a
   * session is registered. `close()` closes the store too. Not with `checkpoint` or `save`.
   */
  readonly store?: CheckpointStore;
  /** Milliseconds between catch-up polls while idle or blocked. Default 1000; 0 disables polling. */
  readonly pollInterval?: number;
  readonly retry?: SyncRetryOptions;
  /** Receive commits over the transport's push channel when it has one. Default true. */
  readonly push?: boolean;
  /** Milliseconds without any push traffic, heartbeats included, before reconnecting. Default 45000; 0 disables. */
  readonly pushTimeout?: number;
  /** Shares ephemeral per-writer state over the push channel; requires a transport with `publishPresence`. */
  readonly presence?: SyncPresenceOptions;
}

export interface SyncClient<S extends SchemaShape> {
  readonly doc: ClientDocument<S>;
  readonly status: SyncStatus;
  /** Why the client failed, while `status` is "failed". */
  readonly error: unknown;
  /** The push channel's state; always "off" without push. */
  readonly push: SyncPushState;
  /** Catches up and submits pending work now; true when everything pending was acknowledged. */
  sync(): Promise<boolean>;
  /** Confirms cancellation of the pending batches that exist when it is called. */
  rejectPending(): Promise<boolean>;
  /** After a history gap with no pending work, registers a new session and closes this client. */
  restartFromSnapshot(): Promise<SyncClient<S>>;
  on(event: "status", listener: (status: SyncStatus) => void): () => void;
  on(event: "push", listener: (push: SyncPushState) => void): () => void;
  /** Stops polling, retries and push and closes the store; final. Responses that arrive later are ignored. */
  close(): void;
}

class ClosedSignal extends Error {}

/** A protocol violation or local failure: never retried. */
class SyncFailure extends Error {
  readonly retryable = false;
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof ClosedSignal) &&
    !(typeof error === "object" && error !== null && "retryable" in error && error.retryable === false);
}


/** A sync client with presence enabled. */
export interface PresenceSyncClient<S extends SchemaShape, P extends JsonValue = JsonValue> extends SyncClient<S> {
  readonly presence: SyncPresence<P>;
}

/**
 * Creates or restores a document and keeps it synchronized through `transport`.
 * The client owns the document's `onBatch`: local edits are scheduled for submission automatically.
 */
export function connectSync<S extends SchemaShape, P extends JsonValue = JsonValue>(
  schema: DocumentSchema<S>,
  options: ConnectSyncOptions<S> & { readonly presence: SyncPresenceOptions<P> }
): Promise<PresenceSyncClient<S, P>>;
export function connectSync<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  options: ConnectSyncOptions<S>
): Promise<SyncClient<S>>;
export function connectSync<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  options: ConnectSyncOptions<S>
): Promise<SyncClient<S>> {
  return start(schema, options, false);
}

/** `restarting` registers a new session even when the store holds a checkpoint. */
async function start<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  options: ConnectSyncOptions<S>,
  restarting: boolean
): Promise<SyncClient<S>> {
  const { store } = options;
  if (store !== undefined && (options.checkpoint !== undefined || options.save !== undefined)) {
    throw new TypeError("store cannot be combined with checkpoint or save");
  }
  const pollInterval = integerOption(options.pollInterval ?? 1000, "pollInterval", 0);
  const initialDelay = integerOption(options.retry?.initialDelay ?? 500, "retry.initialDelay", 0);
  const maxDelay = integerOption(options.retry?.maxDelay ?? 30_000, "retry.maxDelay", 0);
  const pushTimeout = integerOption(options.pushTimeout ?? 45_000, "pushTimeout", 0);
  const { transport } = options;
  if (options.presence !== undefined && transport.publishPresence === undefined) {
    throw new TypeError("presence requires a transport with publishPresence");
  }
  const save = store === undefined ? options.save : (checkpoint: ClientCheckpoint<S>) => store.save(checkpoint);
  let ownsStore = store !== undefined;
  const subscribe = options.push === false ? undefined : transport.subscribe?.bind(transport);

  let doc: ClientDocument<S> | undefined;
  let status: SyncStatus = "idle";
  let error: unknown;
  let running: Promise<boolean> | undefined;
  let rerun = false;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let savedVersion = "";
  let saving: Promise<void> = Promise.resolve();
  const listeners = new Set<(status: SyncStatus) => void>();
  let push: SyncPushState = "off";
  let closePush: (() => void) | undefined;
  let pushToken = 0;
  let pushAttempt = 0;
  let pushRetry: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const pushListeners = new Set<(push: SyncPushState) => void>();

  const onBatch = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (status === "closed" || status === "failed") return;
      // Save local edits now rather than when a pass gets to them: a pass may be waiting on the network.
      void persist().catch(() => {});
      if (status !== "gap") void sync().catch(() => {});
    });
  };
  let restored = options.checkpoint;
  if (store !== undefined && !restarting) {
    const saved = await store.load();
    if (saved !== undefined) restored = decodeClientCheckpoint(schema, saved);
  }
  if (restored !== undefined) {
    doc = createClient(schema, { clientId: restored.clientId, checkpoint: restored, onBatch });
  } else {
    const registration = await transport.register();
    doc = createClient(schema, {
      clientId: registration.clientId, snapshot: decodeSnapshot(schema, registration.snapshot), onBatch,
    });
  }
  const document = doc;
  const presence: PresenceController<JsonValue> | undefined = options.presence === undefined ? undefined : (() => {
    const { clientId } = document.checkpoint();
    return createPresence(options.presence, clientId, (state) => transport.publishPresence!(clientId, state));
  })();

  function setStatus(next: SyncStatus): void {
    if (status === next || status === "closed" || status === "failed") return;
    status = next;
    if (next === "gap" || next === "closed" || next === "failed") shutdownPush();
    if (next === "closed" || next === "failed") presence?.close();
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
    usable(); // Late failures cannot replace a terminal state or its first error.
    error = cause;
    clearTimer();
    setStatus("failed");
    throw error;
  }
  function usable(): void {
    if (status === "closed") throw new ClosedSignal("Sync client is closed");
    if (status === "failed") throw error;
  }
  function schedule(delay: number): void {
    usable();
    clearTimer();
    timer = setTimeout(() => { timer = undefined; void sync().catch(() => {}); }, delay);
  }

  /**
   * Saves when pending work or the watermark changed since the last save. Saves run one at a time and
   * each reads the checkpoint when it starts, so an older checkpoint never overwrites a newer one.
   */
  function persist(): Promise<void> {
    try { usable(); } catch (cause) { return Promise.reject(cause); }
    if (save === undefined) return Promise.resolve();
    const next = saving.then(async () => {
      usable();
      const { lastLocalSeq, serverSeq } = readClientProgress(document);
      const version = `${lastLocalSeq}:${serverSeq}`;
      if (version === savedVersion) return;
      const checkpoint = document.checkpoint();
      try { await save(checkpoint); }
      catch (cause) { fail(cause); }
      usable();
      savedVersion = version;
    });
    saving = next.catch(() => {});
    return next;
  }

  /** Applies every missing commit in order; false when history no longer covers the watermark. */
  async function catchUp(): Promise<boolean> {
    usable();
    const watermark = readClientProgress(document).serverSeq;
    const input = await transport.commitsSince(watermark);
    usable();
    if (input === null) return false;
    const commits = decodeCommits(input);
    // Validate the whole response before applying any of it; never reorder or skip.
    for (const [index, commit] of commits.entries()) {
      if (commit.serverSeq !== watermark + index + 1) throw new SyncFailure("Catch-up commits must be consecutive");
    }
    apply(commits);
    await persist();
    return true;
  }

  function decodeCommits(input: unknown): ServerCommit<DocumentOperation<S>>[] {
    if (!Array.isArray(input)) throw new SyncFailure("Expected a commit array");
    try { return input.map((entry) => decodeServerCommit(schema, entry)); }
    catch (cause) { throw new SyncFailure("Invalid commit", { cause }); }
  }

  function apply(commits: readonly ServerCommit<DocumentOperation<S>>[]): void {
    for (const commit of commits) {
      usable();
      // The commit is applied before listeners run, so a listener bug cannot be retried away.
      try { document.receive(commit); }
      catch (cause) { throw new SyncFailure("A document listener or observer threw", { cause }); }
    }
  }

  /** Applies pushed commits that continue the watermark; anything else falls back to catch-up. */
  async function applyPushed(input: unknown): Promise<boolean> {
    try {
      usable();
      if (status === "gap") return false;
      const watermark = readClientProgress(document).serverSeq;
      // Duplicates and commits a pass already received are ignored.
      const commits = decodeCommits(input).filter((commit) => commit.serverSeq > watermark);
      if (commits.length === 0) return true;
      if (!commits.every((commit, index) => commit.serverSeq === watermark + index + 1)) return await runSync();
      apply(commits);
      await persist();
      // A scheduled retry keeps its backoff; otherwise acknowledged work may unblock the next batch.
      if (status !== "retrying" && readClientProgress(document).nextPendingBatch !== undefined) return await runSync();
      return true;
    } catch (cause) {
      if (cause instanceof ClosedSignal) return false;
      return fail(cause);
    }
  }

  function setPush(next: SyncPushState): void {
    if (push === next) return;
    push = next;
    let thrown: { readonly cause: unknown } | undefined;
    for (const listener of [...pushListeners]) {
      try { listener(next); } catch (cause) { thrown ??= { cause }; }
    }
    if (thrown !== undefined && status !== "failed") fail(new SyncFailure("A push listener threw", thrown));
  }
  function armWatchdog(): void {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = pushTimeout === 0 ? undefined : setTimeout(() => { watchdog = undefined; lostPush(); }, pushTimeout);
  }
  /** Closes the channel and ignores anything its handlers report afterwards. */
  function dropPush(): void {
    pushToken++;
    const close = closePush;
    closePush = undefined;
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = undefined;
    close?.();
    presence?.closed();
    setPush("off");
  }
  function shutdownPush(): void {
    if (pushRetry !== undefined) clearTimeout(pushRetry);
    pushRetry = undefined;
    dropPush();
  }
  /** Terminal push errors fail the client; a lost channel catches up and reconnects after backoff. */
  function lostPush(cause?: unknown): void {
    try {
      usable();
      if (cause !== undefined && !isRetryable(cause)) fail(cause);
      dropPush();
      usable();
      const delay = Math.min(maxDelay, initialDelay * 2 ** pushAttempt);
      pushAttempt = Math.min(pushAttempt + 1, 52);
      pushRetry = setTimeout(() => {
        pushRetry = undefined;
        try { ensurePush(); } catch (failure) { lostPush(failure); }
      }, delay / 2 + Math.random() * (delay / 2));
      if (status === "idle" || status === "blocked") void sync().catch(() => {});
    } catch (failure) {
      if (failure instanceof ClosedSignal) return;
      // Push/timer callbacks have no promise to reject; expose the stored failure instead.
      try { fail(failure); } catch { /* The first failure remains available as client.error. */ }
    }
  }
  function ensurePush(): void {
    if (subscribe === undefined || closePush !== undefined || pushRetry !== undefined) return;
    if (status !== "idle" && status !== "blocked") return;
    const token = ++pushToken;
    const current = () => token === pushToken;
    setPush("connecting");
    usable();
    const close = subscribe(readClientProgress(document).serverSeq, {
      onOpen() {
        if (!current()) return;
        pushAttempt = 0;
        presence?.opened();
        setPush("open");
        if (!current()) return;
        armWatchdog();
        if (status === "idle" || status === "blocked") clearTimer(); // Push replaces polling.
      },
      onActivity() { if (current()) armWatchdog(); },
      onPresence(update) {
        if (!current()) return;
        armWatchdog();
        presence?.received(update);
      },
      onCommits(input) {
        if (!current()) return;
        armWatchdog();
        void exclusive(() => applyPushed(input)).catch(() => {});
      },
      onGap() {
        if (!current()) return;
        dropPush();
        void sync().catch(() => {}); // Catch-up confirms the gap before reporting it.
      },
      onEnd(cause) { if (current()) lostPush(cause); },
    });
    // A transport may report synchronously; keep the channel only while it is current.
    if (current()) closePush = close; else close();
  }
  /** Polls only while no push channel is open. */
  function afterPass(): void {
    usable();
    if (status !== "idle" && status !== "blocked") return;
    ensurePush();
    usable();
    if (pollInterval > 0 && push !== "open") schedule(pollInterval);
  }

  async function pass(): Promise<boolean> {
    usable();
    setStatus("syncing");
    await persist();
    if (!(await catchUp())) { clearTimer(); setStatus("gap"); return false; }
    while (true) {
      usable();
      const batch = readClientProgress(document).nextPendingBatch;
      // Work created before this check is sent by this pass; only later work needs a rerun.
      if (batch === undefined) { rerun = false; setStatus("idle"); return true; }
      // Batches before the conflicting one still replay; send them, then wait.
      if (document.replayConflict?.batch.seq === batch.seq) { setStatus("blocked"); return false; }
      await persist();
      usable();
      await transport.submit(batch);
      usable();
      if (!(await catchUp())) { clearTimer(); setStatus("gap"); return false; }
      if (readClientProgress(document).nextPendingBatch?.seq === batch.seq) {
        throw new SyncFailure("Submission completed without acknowledging the pending batch");
      }
    }
  }

  /** Runs `work` after any running pass; callers that join share its promise. */
  function exclusive(work: () => Promise<boolean>): Promise<boolean> {
    const previous = running;
    let current: Promise<boolean> | undefined;
    current = (async () => {
      try {
        if (previous !== undefined) await previous.catch(() => {});
        usable();
        return await work();
      } catch (cause) {
        if (cause instanceof ClosedSignal) return false;
        throw cause;
      } finally {
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
      afterPass();
      return done;
    } catch (cause) {
      if (status === "closed" || cause instanceof ClosedSignal) return false;
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
    const cutoff = readClientProgress(document).lastLocalSeq;
    clearTimer();
    return exclusive(async () => {
      try {
        setStatus("syncing");
        await persist();
        if (!(await catchUp())) { setStatus("gap"); return false; }
        while (true) {
          usable();
          const batch = readClientProgress(document).nextPendingBatch;
          if (batch === undefined || batch.seq > cutoff) break;
          await transport.reject(batch);
          usable();
          if (!(await catchUp())) { setStatus("gap"); return false; }
          if (readClientProgress(document).nextPendingBatch?.seq === batch.seq) {
            throw new SyncFailure("Rejection completed without acknowledging the pending batch");
          }
        }
        setStatus(document.replayConflict === null ? "idle" : "blocked");
        usable();
        // Batches created after the cutoff are ordinary pending work.
        if (readClientProgress(document).nextPendingBatch !== undefined) rerun = true;
        else afterPass();
        return true;
      } catch (cause) {
        if (status === "closed" || cause instanceof ClosedSignal) return false;
        if (status === "failed" || !isRetryable(cause)) fail(cause);
        // A transport error leaves the outcome unknown; the caller may retry rejectPending().
        setStatus("idle");
        afterPass();
        throw cause;
      }
    });
  }

  const client: SyncClient<S> & { presence?: SyncPresence } = {
    ...(presence === undefined ? {} : { presence: presence.api }),
    doc: document,
    get status() { return status; },
    get error() { return error; },
    get push() { return push; },
    sync,
    rejectPending,
    async restartFromSnapshot() {
      if (status !== "gap") throw new Error("restartFromSnapshot() requires a history gap");
      if (readClientProgress(document).nextPendingBatch !== undefined) {
        throw new Error("restartFromSnapshot() would discard pending work; preserve the checkpoint instead");
      }
      const { checkpoint: _previous, ...rest } = options;
      // The new client takes over the store; its first save replaces this session's checkpoint.
      const next = await start(schema, rest, true);
      ownsStore = false;
      client.close();
      return next;
    },
    on(event: "status" | "push", listener: ((status: SyncStatus) => void) | ((push: SyncPushState) => void)) {
      if (event !== "status" && event !== "push") throw new Error(`Unknown event: ${event as string}`);
      // The overloads pair each event name with its listener type.
      const set = (event === "status" ? listeners : pushListeners) as Set<typeof listener>;
      set.add(listener);
      return () => { set.delete(listener); };
    },
    close() {
      if (ownsStore) { ownsStore = false; store?.close(); }
      if (status === "closed") return;
      clearTimer();
      if (status !== "failed") setStatus("closed");
    },
  };

  await persist();
  if (readClientProgress(document).nextPendingBatch !== undefined) onBatch();
  else if (pollInterval > 0 || subscribe !== undefined) schedule(0);
  return client;
}
