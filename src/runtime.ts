import {
  freezeListOperation,
  ListState,
  RuntimeList,
  type List,
  type ListDeleteOperation,
  type ListInsertOperation,
  type ListOperation,
  type ListSnapshotData,
} from "./list.ts";
import type {
  DocumentSchema,
  JsonValue,
  ListSchema,
  SchemaShape,
  SnapshotType,
  ValueSchema,
} from "./schema.ts";

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
  | ListDeleteOperation;

type OperationFor<D, Path extends string> =
  D extends ValueSchema<infer T extends JsonValue>
    ? ValueSetOperation<Path, T>
    : D extends ListSchema<infer T extends JsonValue>
      ? ListOperation<Path, T>
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

export interface CreateClientOptions<S extends SchemaShape> {
  readonly clientId: string;
  readonly onBatch: (batch: ClientBatch<DocumentOperation<S>>) => void;
  readonly snapshot?: DocumentSnapshot<S>;
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

  constructor(
    mutate: (operation: ValueSetOperation<string, T>) => void,
    path: string,
    initialValue: T
  ) {
    this.mutate = mutate;
    this.path = path;
    this.current = initialValue;
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

type CollectionState = JsonValue | ListState<JsonValue>;
type RuntimeCollection = RuntimeValue<JsonValue> | RuntimeList<JsonValue>;

function wrongCollectionKind(path: string): Error {
  return new Error(`Operation type does not match document path: ${path}`);
}

function applyOperations(
  states: Map<string, CollectionState>,
  operations: readonly Operation[]
): void {
  for (const operation of operations) {
    if (!states.has(operation.path)) {
      throw new Error(`Unknown document path: ${operation.path}`);
    }
    const current = states.get(operation.path)!;

    switch (operation.type) {
      case "value/set":
        if (current instanceof ListState) {
          throw wrongCollectionKind(operation.path);
        }
        states.set(operation.path, operation.value);
        break;
      case "list/insert":
        if (!(current instanceof ListState)) {
          throw wrongCollectionKind(operation.path);
        }
        states.set(operation.path, current.insert(operation));
        break;
      case "list/delete":
        if (!(current instanceof ListState)) {
          throw wrongCollectionKind(operation.path);
        }
        states.set(operation.path, current.delete(operation));
        break;
    }
  }
}

function validateSnapshot<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  snapshot: DocumentSnapshot<S>
): Readonly<Record<string, unknown>> {
  if (!Number.isInteger(snapshot.serverSeq) || snapshot.serverSeq < 0) {
    throw new Error(
      `Snapshot server sequence must be a non-negative integer: ${snapshot.serverSeq}`
    );
  }
  if (
    typeof snapshot.data !== "object" ||
    snapshot.data === null ||
    Array.isArray(snapshot.data)
  ) {
    throw new Error("Snapshot data must be an object");
  }

  const schemaPaths = Object.keys(schema.definition);
  const snapshotData = snapshot.data as Readonly<Record<string, unknown>>;
  for (const path of schemaPaths) {
    if (!Object.hasOwn(snapshotData, path)) {
      throw new Error(`Missing snapshot path: ${path}`);
    }
  }

  const schemaPathSet = new Set(schemaPaths);
  for (const path of Object.keys(snapshotData)) {
    if (!schemaPathSet.has(path)) {
      throw new Error(`Unknown snapshot path: ${path}`);
    }
  }
  return snapshotData;
}

function initialStates<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  snapshot: DocumentSnapshot<S> | undefined
): Map<string, CollectionState> {
  const snapshotData =
    snapshot === undefined ? undefined : validateSnapshot(schema, snapshot);
  const states = new Map<string, CollectionState>();

  for (const path of Object.keys(schema.definition) as Array<
    Extract<keyof S, string>
  >) {
    const descriptor = schema.definition[path];
    if (descriptor.kind === "value") {
      const value =
        snapshotData === undefined
          ? descriptor.initialValue
          : snapshotData[path];
      if (value === undefined) {
        throw new Error(`Missing document path: ${path}`);
      }
      states.set(path, value as JsonValue);
    } else {
      states.set(
        path,
        snapshotData === undefined
          ? ListState.empty()
          : ListState.load(snapshotData[path] as ListSnapshotData<JsonValue>)
      );
    }
  }
  return states;
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
  if (state instanceof ListState) throw wrongCollectionKind(path);
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
  } else {
    if (state instanceof ListState) throw wrongCollectionKind(path);
    runtime.restore(state);
  }
}

function freezeOperation(operation: Operation): Operation {
  if (operation.type === "value/set") {
    return Object.freeze({ ...operation });
  }
  return freezeListOperation(operation);
}

type DocumentCollection<D> =
  D extends ValueSchema<infer T extends JsonValue>
    ? Value<T>
    : D extends ListSchema<infer T extends JsonValue>
      ? List<T>
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
  private authoritativeStates = new Map<string, CollectionState>();
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

    this.clientId = options.clientId;
    this.onBatch = options.onBatch;
    const states = initialStates(schema, options.snapshot);
    this.lastServerSeq = options.snapshot?.serverSeq ?? 0;

    const publicState: Partial<
      Record<keyof S, Value<JsonValue> | List<JsonValue>>
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
        if (collectionState instanceof ListState) throw wrongCollectionKind(path);
        runtime = new RuntimeValue(
          (operation) => this.mutate(operation),
          path,
          collectionState
        );
      } else {
        if (!(collectionState instanceof ListState)) {
          throw wrongCollectionKind(path);
        }
        runtime = new RuntimeList(
          (operation) => this.mutate(operation),
          this.clientId,
          path,
          collectionState
        );
      }
      this.collections.set(path, runtime);
      this.authoritativeStates.set(path, collectionState);
      publicState[path] = runtime;
    }
    this.state = Object.freeze(publicState) as DocumentState<S>;
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

/** A synchronous authoritative document that orders accepted client batches. */
export class ServerDocument<S extends SchemaShape> {
  private authoritativeStates: Map<string, CollectionState>;
  private readonly nextClientSeq = new Map<string, number>();
  private nextServerSeq = 1;

  constructor(schema: DocumentSchema<S>) {
    this.authoritativeStates = initialStates(schema, undefined);
  }

  /** Returns the current authoritative state and its server sequence. */
  snapshot(): DocumentSnapshot<S> {
    const data = Object.freeze(
      Object.fromEntries(
        [...this.authoritativeStates].map(([path, state]) => [
          path,
          state instanceof ListState ? state.save() : state,
        ])
      )
    ) as DocumentSnapshotData<S>;
    return Object.freeze({
      serverSeq: this.nextServerSeq - 1,
      data,
    });
  }

  /** Accepts the next batch from a client and returns its server commit. */
  receive(
    batch: ClientBatch<DocumentOperation<S>>
  ): ServerCommit<DocumentOperation<S>> {
    const expectedClientSeq = this.nextClientSeq.get(batch.clientId) ?? 1;
    if (batch.seq !== expectedClientSeq) {
      throw new Error(
        `Expected client sequence ${expectedClientSeq} for ${batch.clientId}, received ${batch.seq}`
      );
    }

    const operations = Object.freeze(
      batch.operations.map(freezeOperation)
    ) as readonly DocumentOperation<S>[];
    const nextAuthoritativeStates = new Map(this.authoritativeStates);
    applyOperations(nextAuthoritativeStates, operations);

    const commit: ServerCommit<DocumentOperation<S>> = Object.freeze({
      serverSeq: this.nextServerSeq,
      source: Object.freeze({ clientId: batch.clientId, seq: batch.seq }),
      operations,
    });

    this.authoritativeStates = nextAuthoritativeStates;
    this.nextClientSeq.set(batch.clientId, expectedClientSeq + 1);
    this.nextServerSeq++;
    return commit;
  }
}

export function createClient<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  options: CreateClientOptions<S>
): ClientDocument<S> {
  return new ClientDocument(schema, options);
}

export function createServer<S extends SchemaShape>(
  schema: DocumentSchema<S>
): ServerDocument<S> {
  return new ServerDocument(schema);
}
