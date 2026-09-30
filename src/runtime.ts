import {
  freezeListOperation,
  ListState,
  RuntimeList,
  type List,
  type ListDeleteOperation,
  type ListInsertOperation,
  type ListOperation,
} from "./list.ts";
import {
  freezeTextOperation,
  RuntimeText,
  TextState,
  type Text,
  type TextDeleteOperation,
  type TextInsertOperation,
  type TextOperation,
} from "./text.ts";
import type {
  DocumentSchema,
  JsonValue,
  ListSchema,
  SchemaShape,
  SnapshotType,
  TextSchema,
  ValueSchema,
} from "./schema.ts";
import { decodeClientCheckpoint, decodeServerCheckpoint } from "./wire.ts";
import {
  applyOperations,
  initialStates,
  saveSnapshot,
  unknownOperationType,
  wrongCollectionKind,
  type CollectionState,
} from "./state.ts";
import { jsonEquals } from "./json.ts";

export interface ValueSetOperation<
  Path extends string = string,
  T extends JsonValue = JsonValue,
> {
  readonly type: "value/set";
  readonly path: Path;
  readonly value: T;
}

export type Operation =
  | ValueSetOperation
  | ListInsertOperation
  | ListDeleteOperation
  | TextInsertOperation
  | TextDeleteOperation;

type OperationFor<D, Path extends string> =
  D extends ValueSchema<infer T extends JsonValue>
    ? ValueSetOperation<Path, T>
    : D extends ListSchema<infer T extends JsonValue>
      ? ListOperation<Path, T>
      : D extends TextSchema
        ? TextOperation<Path>
        : never;

export type DocumentOperation<S extends SchemaShape> = {
  [K in Extract<keyof S, string>]: OperationFor<S[K], K>;
}[Extract<keyof S, string>];

export interface ClientBatchRef {
  readonly clientId: string;
  readonly seq: number;
}

export interface ClientBatch<TOperation extends Operation = Operation>
  extends ClientBatchRef {
  readonly operations: readonly TOperation[];
}

export interface ServerCommit<TOperation extends Operation = Operation> {
  readonly serverSeq: number;
  readonly source: ClientBatchRef;
  readonly operations: readonly TOperation[];
}

/** Transport-local routing information; only the commit goes on the wire. */
export interface ServerReceipt<TOperation extends Operation = Operation> {
  readonly commit: ServerCommit<TOperation>;
  readonly replayed: boolean;
}

export interface ServerReplayEntry<TOperation extends Operation = Operation> {
  readonly batch: ClientBatch<TOperation>;
  readonly commit: ServerCommit<TOperation>;
}

export interface LocalChangeEvent<TOperation extends Operation = Operation> {
  readonly origin: "local";
  readonly batch: ClientBatch<TOperation>;
}

export interface ServerChangeEvent<TOperation extends Operation = Operation> {
  readonly origin: "server";
  readonly commit: ServerCommit<TOperation>;
}

export type ChangeEvent<TOperation extends Operation = Operation> =
  | LocalChangeEvent<TOperation>
  | ServerChangeEvent<TOperation>;

export type DocumentSnapshotData<S extends SchemaShape> = Readonly<{
  [K in keyof S]: SnapshotType<S[K]>;
}>;

export interface DocumentSnapshot<
  S extends SchemaShape = SchemaShape,
> {
  readonly serverSeq: number;
  readonly data: DocumentSnapshotData<S>;
}

export interface ServerCheckpoint<
  S extends SchemaShape = SchemaShape,
> {
  readonly snapshot: DocumentSnapshot<S>;
  readonly replays: readonly ServerReplayEntry<DocumentOperation<S>>[];
  readonly history: readonly ServerCommit<DocumentOperation<S>>[];
}

export interface ClientCheckpoint<S extends SchemaShape = SchemaShape> {
  readonly clientId: string;
  readonly snapshot: DocumentSnapshot<S>;
  /** Last emitted local batch sequence, including still-pending batches. */
  readonly lastLocalSeq: number;
  readonly pendingBatches: readonly ClientBatch<DocumentOperation<S>>[];
  /** Last allocated bunch per List/Text path, including rolled-back allocations. */
  readonly lastBunchSeqs: Readonly<{
    [K in keyof S as S[K] extends ValueSchema ? never : K]: number;
  }>;
}

export interface CreateClientOptions<S extends SchemaShape> {
  readonly clientId: string;
  readonly onBatch: (batch: ClientBatch<DocumentOperation<S>>) => void;
  readonly snapshot?: DocumentSnapshot<S>;
  readonly checkpoint?: ClientCheckpoint<S>;
}

export interface ServerResolveContext<S extends SchemaShape> {
  readonly batch: ClientBatch<DocumentOperation<S>>;
  readonly snapshot: DocumentSnapshot<S>;
}

export type ServerResolver<S extends SchemaShape> = (
  context: ServerResolveContext<S>
) => readonly DocumentOperation<S>[];

export interface CreateServerOptions<S extends SchemaShape> {
  readonly resolve?: ServerResolver<S>;
  readonly checkpoint?: ServerCheckpoint<S>;
  readonly historyLimit?: number;
}

/** An optimistic collaborative value. Values are treated as immutable. */
export interface Value<T extends JsonValue> {
  get value(): T;
  set value(nextValue: T);
  set(nextValue: T): void;
}

class RuntimeValue<T extends JsonValue> implements Value<T> {
  private current: T;
  private readonly path: string;
  private readonly mutate: (operation: ValueSetOperation<string, T>) => void;
  private readonly beforeMutation: () => void;

  constructor(
    mutate: (operation: ValueSetOperation<string, T>) => void,
    path: string,
    initialValue: T,
    beforeMutation: () => void
  ) {
    this.mutate = mutate;
    this.path = path;
    this.current = initialValue;
    this.beforeMutation = beforeMutation;
  }

  get state(): T {
    return this.current;
  }

  get value(): T {
    return this.current;
  }

  set value(nextValue: T) {
    this.set(nextValue);
  }

  set(nextValue: T): void {
    this.beforeMutation();
    this.current = nextValue;
    this.mutate(
      Object.freeze({
        type: "value/set",
        path: this.path,
        value: nextValue,
      })
    );
  }

  restore(value: T): void {
    this.current = value;
  }

  visibleEquals(value: T): boolean {
    return Object.is(this.current, value);
  }
}

type RuntimeCollection =
  | RuntimeValue<JsonValue>
  | RuntimeList<JsonValue>
  | RuntimeText;

function restoreServerCheckpoint<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  checkpoint: ServerCheckpoint<S>
): {
  readonly states: Map<string, CollectionState>;
  readonly replays: Map<string, ServerReplayEntry<DocumentOperation<S>>>;
  readonly history: readonly ServerCommit<DocumentOperation<S>>[];
  readonly nextServerSeq: number;
} {
  // Use the same structural and cross-entry validation at both restore boundaries.
  const owned = decodeServerCheckpoint(schema, checkpoint);
  return {
    states: initialStates(schema, owned.snapshot),
    replays: new Map(owned.replays.map((entry) => [entry.batch.clientId, entry])),
    history: owned.history,
    nextServerSeq: owned.snapshot.serverSeq + 1,
  };
}

function runtimeState(runtime: RuntimeCollection): CollectionState {
  return runtime.state;
}

function runtimeVisibleEquals(
  runtime: RuntimeCollection,
  state: CollectionState,
  path: string
): boolean {
  if (runtime instanceof RuntimeList) {
    if (!(state instanceof ListState)) throw wrongCollectionKind(path);
    return runtime.visibleEquals(state);
  }
  if (runtime instanceof RuntimeText) {
    if (!(state instanceof TextState)) throw wrongCollectionKind(path);
    return runtime.visibleEquals(state);
  }
  if (state instanceof ListState || state instanceof TextState) {
    throw wrongCollectionKind(path);
  }
  return runtime.visibleEquals(state);
}

function restoreRuntime(
  runtime: RuntimeCollection,
  state: CollectionState,
  path: string
): void {
  if (runtime instanceof RuntimeList) {
    if (!(state instanceof ListState)) throw wrongCollectionKind(path);
    runtime.restore(state);
  } else if (runtime instanceof RuntimeText) {
    if (!(state instanceof TextState)) throw wrongCollectionKind(path);
    runtime.restore(state);
  } else {
    if (state instanceof ListState || state instanceof TextState) {
      throw wrongCollectionKind(path);
    }
    runtime.restore(state);
  }
}

function freezeOperation(operation: Operation): Operation {
  switch (operation.type) {
    case "value/set":
      return Object.freeze({ ...operation });
    case "list/insert":
    case "list/delete":
      return freezeListOperation(operation);
    case "text/insert":
    case "text/delete":
      return freezeTextOperation(operation);
    default:
      throw unknownOperationType(operation);
  }
}

function freezeOperations<TOperation extends Operation>(
  operations: readonly TOperation[]
): readonly TOperation[] {
  return Object.freeze(
    operations.map((operation) => freezeOperation(operation) as TOperation)
  );
}

type DocumentCollection<D> =
  D extends ValueSchema<infer T extends JsonValue>
    ? Value<T>
    : D extends ListSchema<infer T extends JsonValue>
      ? List<T>
      : D extends TextSchema
        ? Text
        : never;

export type DocumentState<S extends SchemaShape> = Readonly<{
  [K in keyof S]: DocumentCollection<S[K]>;
}>;

type ChangeListener<S extends SchemaShape> = (
  event: ChangeEvent<DocumentOperation<S>>
) => void;

/** A client-side optimistic document with server reconciliation. */
export class ClientDocument<S extends SchemaShape> {
  readonly state: DocumentState<S>;

  private readonly clientId: string;
  private readonly onBatch: CreateClientOptions<S>["onBatch"];
  private readonly listeners = new Set<ChangeListener<S>>();
  private readonly collections = new Map<string, RuntimeCollection>();
  private authoritativeStates: Map<string, CollectionState>;
  private readonly pendingBatches: ClientBatch<DocumentOperation<S>>[] = [];

  private nextSeq = 1;
  private lastServerSeq = 0;
  private transactionDepth = 0;
  private operations: Operation[] = [];
  private transactionSnapshot: Map<string, CollectionState> | undefined;

  constructor(schema: DocumentSchema<S>, options: CreateClientOptions<S>) {
    if (options.clientId.length === 0) {
      throw new Error("clientId must not be empty");
    }

    if (options.snapshot !== undefined && options.checkpoint !== undefined) {
      throw new Error("Cannot provide both snapshot and checkpoint");
    }
    const checkpoint =
      options.checkpoint === undefined
        ? undefined
        : decodeClientCheckpoint(schema, options.checkpoint);
    if (checkpoint !== undefined && checkpoint.clientId !== options.clientId) {
      throw new Error("Checkpoint clientId must match client options");
    }

    this.clientId = options.clientId;
    this.onBatch = options.onBatch;
    const snapshot = checkpoint?.snapshot ?? options.snapshot;
    this.authoritativeStates = initialStates(schema, snapshot);
    this.lastServerSeq = snapshot?.serverSeq ?? 0;
    this.nextSeq = checkpoint === undefined ? 1 : checkpoint.lastLocalSeq + 1;
    if (checkpoint !== undefined) {
      for (const batch of checkpoint.pendingBatches) {
        this.pendingBatches.push(batch);
      }
    }
    const states = new Map(this.authoritativeStates);
    for (const batch of this.pendingBatches) {
      applyOperations(states, batch.operations);
    }
    const lastBunchSeqs = checkpoint?.lastBunchSeqs as
      | Readonly<Record<string, number>>
      | undefined;
    const beforeMutation = () => this.assertCanMutate();

    const publicState: Partial<
      Record<keyof S, Value<JsonValue> | List<JsonValue> | Text>
    > = {};
    for (const path of Object.keys(schema.definition) as Array<
      Extract<keyof S, string>
    >) {
      const descriptor = schema.definition[path];
      const collectionState = states.get(path);
      if (collectionState === undefined) {
        throw new Error(`Missing document path: ${path}`);
      }

      let runtime: RuntimeCollection;
      if (descriptor.kind === "value") {
        if (
          collectionState instanceof ListState ||
          collectionState instanceof TextState
        ) {
          throw wrongCollectionKind(path);
        }
        runtime = new RuntimeValue(
          (operation) => this.mutate(operation),
          path,
          collectionState,
          beforeMutation
        );
      } else if (descriptor.kind === "list") {
        if (!(collectionState instanceof ListState)) {
          throw wrongCollectionKind(path);
        }
        runtime = new RuntimeList(
          (operation) => this.mutate(operation),
          this.clientId,
          path,
          collectionState,
          beforeMutation,
          lastBunchSeqs?.[path] ?? 0
        );
      } else {
        if (!(collectionState instanceof TextState)) {
          throw wrongCollectionKind(path);
        }
        runtime = new RuntimeText(
          (operation) => this.mutate(operation),
          this.clientId,
          path,
          collectionState,
          beforeMutation,
          lastBunchSeqs?.[path] ?? 0
        );
      }
      this.collections.set(path, runtime);
      publicState[path] = runtime;
    }
    this.state = Object.freeze(publicState) as DocumentState<S>;
  }

  /** Saves authoritative state and the pending work needed to rebuild this client. */
  checkpoint(): ClientCheckpoint<S> {
    if (this.transactionDepth !== 0) {
      throw new Error("Cannot checkpoint during a transaction");
    }
    const lastBunchSeqs = Object.freeze(
      Object.fromEntries(
        [...this.collections].flatMap(([path, runtime]) =>
          runtime instanceof RuntimeList || runtime instanceof RuntimeText
            ? [[path, runtime.lastBunchSeq]]
            : []
        )
      )
    ) as ClientCheckpoint<S>["lastBunchSeqs"];
    return Object.freeze({
      clientId: this.clientId,
      snapshot: saveSnapshot<S>(this.authoritativeStates, this.lastServerSeq),
      lastLocalSeq: this.nextSeq - 1,
      pendingBatches: Object.freeze([...this.pendingBatches]),
      lastBunchSeqs,
    });
  }

  private assertCanMutate(): void {
    if (!Number.isSafeInteger(this.nextSeq)) {
      throw new Error("Client sequence exhausted");
    }
  }

  private mutate(operation: Operation): void {
    this.operations.push(operation);
    if (this.transactionDepth === 0) this.commit();
  }

  /** Groups all synchronous mutations in callback into one client batch. */
  transact<T>(
    callback: () => T,
    ...mustBeSynchronous: [T] extends [never]
      ? []
      : T extends PromiseLike<unknown>
        ? [never]
        : []
  ): T;
  transact<T>(callback: () => T): T {
    const isOuterTransaction = this.transactionDepth === 0;
    if (isOuterTransaction) {
      this.transactionSnapshot = new Map(
        [...this.collections].map(([path, runtime]) => [
          path,
          runtimeState(runtime),
        ])
      );
    }

    this.transactionDepth++;
    let result: T;
    try {
      result = callback();
    } catch (error) {
      this.transactionDepth--;
      if (isOuterTransaction) this.rollbackTransaction();
      throw error;
    }

    this.transactionDepth--;
    if (isOuterTransaction) {
      this.transactionSnapshot = undefined;
      this.commit();
    }
    return result;
  }

  on(event: "change", listener: ChangeListener<S>): () => void {
    if (event !== "change") {
      throw new Error(`Unknown event: ${event as string}`);
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Applies the next authoritative server commit and replays local changes. */
  receive(commit: ServerCommit<DocumentOperation<S>>): void {
    if (this.transactionDepth !== 0) {
      throw new Error("Cannot receive a server commit during a transaction");
    }

    const expectedServerSeq = this.lastServerSeq + 1;
    if (commit.serverSeq !== expectedServerSeq) {
      throw new Error(
        `Expected server sequence ${expectedServerSeq}, received ${commit.serverSeq}`
      );
    }

    const isOwnCommit = commit.source.clientId === this.clientId;
    if (isOwnCommit) {
      const pending = this.pendingBatches[0];
      if (pending === undefined || pending.seq !== commit.source.seq) {
        throw new Error(
          `Server commit does not match the next pending batch: ${commit.source.seq}`
        );
      }
    }

    const nextAuthoritativeStates = new Map(this.authoritativeStates);
    applyOperations(nextAuthoritativeStates, commit.operations);

    const remainingBatches = isOwnCommit
      ? this.pendingBatches.slice(1)
      : this.pendingBatches;
    const nextOptimisticStates = new Map(nextAuthoritativeStates);
    for (const pending of remainingBatches) {
      applyOperations(nextOptimisticStates, pending.operations);
    }

    let changed = false;
    for (const [path, runtime] of this.collections) {
      const nextState = nextOptimisticStates.get(path);
      if (nextState === undefined) {
        throw new Error(`Missing document path: ${path}`);
      }
      if (!runtimeVisibleEquals(runtime, nextState, path)) changed = true;
    }

    this.authoritativeStates = nextAuthoritativeStates;
    if (isOwnCommit) this.pendingBatches.shift();
    this.lastServerSeq = commit.serverSeq;

    for (const [path, runtime] of this.collections) {
      restoreRuntime(runtime, nextOptimisticStates.get(path)!, path);
    }

    if (changed) {
      this.emitChange(Object.freeze({ origin: "server", commit }));
    }
  }

  private commit(): void {
    if (this.operations.length === 0) return;

    const operations = Object.freeze(
      this.operations.splice(0)
    ) as readonly DocumentOperation<S>[];
    const batch: ClientBatch<DocumentOperation<S>> = Object.freeze({
      clientId: this.clientId,
      seq: this.nextSeq++,
      operations,
    });

    this.pendingBatches.push(batch);
    this.onBatch(batch);
    this.emitChange(Object.freeze({ origin: "local", batch }));
  }

  private emitChange(event: ChangeEvent<DocumentOperation<S>>): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private rollbackTransaction(): void {
    const snapshot = this.transactionSnapshot;
    this.transactionSnapshot = undefined;
    this.operations = [];

    if (snapshot === undefined) return;
    for (const [path, state] of snapshot) {
      const runtime = this.collections.get(path);
      if (runtime !== undefined) restoreRuntime(runtime, state, path);
    }
  }
}

/** A synchronous authoritative document that resolves and orders client batches. */
export class ServerDocument<S extends SchemaShape> {
  private authoritativeStates: Map<string, CollectionState>;
  private readonly replays: Map<string, ServerReplayEntry<DocumentOperation<S>>>;
  private readonly historyLimit: number;
  private history: readonly ServerCommit<DocumentOperation<S>>[];
  private readonly resolve: ServerResolver<S> | undefined;
  private nextServerSeq = 1;
  private receiving = false;

  constructor(
    schema: DocumentSchema<S>,
    options: CreateServerOptions<S> = {}
  ) {
    const historyLimit =
      options.historyLimit === undefined ? 1000 : options.historyLimit;
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 0) {
      throw new Error("historyLimit must be a non-negative safe integer");
    }
    this.historyLimit = historyLimit;
    const restored =
      options.checkpoint === undefined
        ? undefined
        : restoreServerCheckpoint(schema, options.checkpoint);
    this.authoritativeStates =
      restored?.states ?? initialStates(schema, undefined);
    this.replays = restored?.replays ?? new Map();
    this.history =
      historyLimit === 0 ? [] : (restored?.history ?? []).slice(-historyLimit);
    this.nextServerSeq = restored?.nextServerSeq ?? 1;
    this.resolve = options.resolve;
  }

  /** Returns the current authoritative state and its server sequence. */
  snapshot(): DocumentSnapshot<S> {
    return saveSnapshot<S>(this.authoritativeStates, this.nextServerSeq - 1);
  }

  /** Returns the state needed to restore this authoritative server. */
  checkpoint(): ServerCheckpoint<S> {
    return Object.freeze({
      snapshot: this.snapshot(),
      replays: Object.freeze([...this.replays.values()]),
      history: Object.freeze([...this.history]),
    });
  }

  /** Returns every later commit, or null if any required history was evicted. */
  commitsSince(
    serverSeq: number
  ): readonly ServerCommit<DocumentOperation<S>>[] | null {
    const currentSeq = this.nextServerSeq - 1;
    if (!Number.isSafeInteger(serverSeq) || serverSeq < 0 || serverSeq > currentSeq) {
      throw new Error(
        "Catch-up watermark must be a non-negative safe integer no greater than the current server sequence"
      );
    }
    if (serverSeq === currentSeq) return Object.freeze([]);
    const first = this.history[0];
    if (first === undefined || serverSeq < first.serverSeq - 1) return null;
    return Object.freeze(this.history.slice(serverSeq - first.serverSeq + 1));
  }

  /** Resolves the next batch or replays this client's last identical batch. */
  receive(
    batch: ClientBatch<DocumentOperation<S>>
  ): ServerReceipt<DocumentOperation<S>> {
    if (this.receiving) {
      throw new Error("Cannot call server.receive() reentrantly");
    }

    this.receiving = true;
    try {
      const previous = this.replays.get(batch.clientId);
      const expectedClientSeq = (previous?.batch.seq ?? 0) + 1;
      if (previous !== undefined && batch.seq === previous.batch.seq) {
        if (!jsonEquals(batch.operations, previous.batch.operations)) {
          throw new Error(
            `Retry batch differs from the saved batch for ${batch.clientId} sequence ${batch.seq}`
          );
        }
        return Object.freeze({ commit: previous.commit, replayed: true });
      }
      if (batch.seq !== expectedClientSeq) {
        throw new Error(
          `Expected client sequence ${expectedClientSeq} for ${batch.clientId}, received ${batch.seq}`
        );
      }
      if (!Number.isSafeInteger(this.nextServerSeq)) {
        throw new Error("Server sequence exhausted");
      }

      const incomingOperations = freezeOperations(batch.operations);
      const ownedBatch: ClientBatch<DocumentOperation<S>> = Object.freeze({
        clientId: batch.clientId,
        seq: batch.seq,
        operations: incomingOperations,
      });
      const resolvedOperations =
        this.resolve === undefined
          ? incomingOperations
          : this.resolve(
              Object.freeze({
                batch: ownedBatch,
                snapshot: this.snapshot(),
              })
            );
      if (!Array.isArray(resolvedOperations)) {
        throw new Error("Server resolver must return an array of operations");
      }

      const operations = freezeOperations(resolvedOperations);
      const nextAuthoritativeStates = new Map(this.authoritativeStates);
      applyOperations(nextAuthoritativeStates, operations);

      const commit: ServerCommit<DocumentOperation<S>> = Object.freeze({
        serverSeq: this.nextServerSeq,
        source: Object.freeze({ clientId: ownedBatch.clientId, seq: ownedBatch.seq }),
        operations,
      });
      const nextHistory =
        this.historyLimit === 0
          ? []
          : [...this.history, commit].slice(-this.historyLimit);

      this.authoritativeStates = nextAuthoritativeStates;
      this.replays.set(
        ownedBatch.clientId,
        Object.freeze({ batch: ownedBatch, commit })
      );
      this.history = nextHistory;
      this.nextServerSeq++;
      return Object.freeze({ commit, replayed: false });
    } finally {
      this.receiving = false;
    }
  }
}

export function createClient<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  options: CreateClientOptions<S>
): ClientDocument<S> {
  return new ClientDocument(schema, options);
}

export function createServer<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  options: CreateServerOptions<S> = {}
): ServerDocument<S> {
  return new ServerDocument(schema, options);
}
