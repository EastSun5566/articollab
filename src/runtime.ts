import type {
  DocumentSchema,
  JsonValue,
  SchemaShape,
  SnapshotType,
  ValueType,
} from "./schema.ts";

export interface ValueSetOperation<
  Path extends string = string,
  T extends JsonValue = JsonValue,
> {
  readonly type: "value/set";
  readonly path: Path;
  readonly value: T;
}

export type Operation = ValueSetOperation;

export type DocumentOperation<S extends SchemaShape> = {
  [K in Extract<keyof S, string>]: ValueSetOperation<K, ValueType<S[K]>>;
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
  private readonly mutate: (path: string, value: JsonValue) => void;

  constructor(
    mutate: (path: string, value: JsonValue) => void,
    path: string,
    initialValue: T
  ) {
    this.mutate = mutate;
    this.path = path;
    this.current = initialValue;
  }

  get value(): T {
    return this.current;
  }

  set value(nextValue: T) {
    this.set(nextValue);
  }

  set(nextValue: T): void {
    this.current = nextValue;
    this.mutate(this.path, nextValue);
  }

  restore(value: T): void {
    this.current = value;
  }
}

function applyOperations(
  values: Map<string, JsonValue>,
  operations: readonly Operation[]
): void {
  for (const operation of operations) {
    if (!values.has(operation.path)) {
      throw new Error(`Unknown document path: ${operation.path}`);
    }
    values.set(operation.path, operation.value);
  }
}

function initialValues<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  snapshot: DocumentSnapshot<S> | undefined
): Map<string, JsonValue> {
  if (snapshot === undefined) {
    return new Map(
      Object.entries(schema.definition).map(([path, descriptor]) => [
        path,
        descriptor.initialValue,
      ])
    );
  }

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
  const snapshotData = snapshot.data as Readonly<Record<string, JsonValue>>;
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

  return new Map(schemaPaths.map((path) => [path, snapshotData[path]!]));
}

export type DocumentState<S extends SchemaShape> = Readonly<{
  [K in keyof S]: Value<ValueType<S[K]>>;
}>;

type ChangeListener<S extends SchemaShape> = (
  event: ChangeEvent<DocumentOperation<S>>
) => void;

/**
 * A client-side optimistic document.
 *
 * Local batches are applied optimistically, then reconciled with authoritative
 * server commits in server sequence order.
 */
export class ClientDocument<S extends SchemaShape> {
  readonly state: DocumentState<S>;

  private readonly clientId: string;
  private readonly onBatch: CreateClientOptions<S>["onBatch"];
  private readonly listeners = new Set<ChangeListener<S>>();
  private readonly values = new Map<string, RuntimeValue<JsonValue>>();
  private authoritativeValues = new Map<string, JsonValue>();
  private readonly pendingBatches: ClientBatch<DocumentOperation<S>>[] = [];

  private nextSeq = 1;
  private lastServerSeq = 0;
  private transactionDepth = 0;
  private operations: Operation[] = [];
  private transactionSnapshot: Map<string, JsonValue> | undefined;

  constructor(schema: DocumentSchema<S>, options: CreateClientOptions<S>) {
    if (options.clientId.length === 0) {
      throw new Error("clientId must not be empty");
    }

    this.clientId = options.clientId;
    this.onBatch = options.onBatch;
    const hydratedValues = initialValues(schema, options.snapshot);
    this.lastServerSeq = options.snapshot?.serverSeq ?? 0;

    const state: Partial<Record<keyof S, Value<JsonValue>>> = {};
    for (const path of Object.keys(schema.definition) as Array<
      Extract<keyof S, string>
    >) {
      const initialValue = hydratedValues.get(path);
      if (initialValue === undefined) {
        throw new Error(`Missing document path: ${path}`);
      }
      const runtimeValue = new RuntimeValue(
        (mutationPath, value) => this.setValue(mutationPath, value),
        path,
        initialValue
      );
      this.values.set(path, runtimeValue);
      this.authoritativeValues.set(path, initialValue);
      state[path] = runtimeValue;
    }
    this.state = Object.freeze(state) as DocumentState<S>;
  }

  private setValue(path: string, value: JsonValue): void {
    const operation: Operation = Object.freeze({
      type: "value/set",
      path,
      value,
    });
    this.operations.push(operation);

    if (this.transactionDepth === 0) {
      this.commit();
    }
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
        [...this.values].map(([path, runtimeValue]) => [
          path,
          runtimeValue.value,
        ])
      );
    }

    this.transactionDepth++;
    let result: T;
    try {
      result = callback();
    } catch (error) {
      this.transactionDepth--;
      if (isOuterTransaction) {
        this.rollbackTransaction();
      }
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

    const nextAuthoritativeValues = new Map(this.authoritativeValues);
    applyOperations(nextAuthoritativeValues, commit.operations);

    const remainingBatches = isOwnCommit
      ? this.pendingBatches.slice(1)
      : this.pendingBatches;
    const nextOptimisticValues = new Map(nextAuthoritativeValues);
    for (const pending of remainingBatches) {
      applyOperations(nextOptimisticValues, pending.operations);
    }

    let changed = false;
    for (const [path, runtimeValue] of this.values) {
      const nextValue = nextOptimisticValues.get(path);
      if (nextValue === undefined && !nextOptimisticValues.has(path)) {
        throw new Error(`Missing document path: ${path}`);
      }
      if (!Object.is(runtimeValue.value, nextValue)) changed = true;
    }

    this.authoritativeValues = nextAuthoritativeValues;
    if (isOwnCommit) this.pendingBatches.shift();
    this.lastServerSeq = commit.serverSeq;

    for (const [path, runtimeValue] of this.values) {
      runtimeValue.restore(nextOptimisticValues.get(path)!);
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
    for (const [path, value] of snapshot) {
      this.values.get(path)?.restore(value);
    }
  }
}

/** A synchronous authoritative document that orders accepted client batches. */
export class ServerDocument<S extends SchemaShape> {
  private authoritativeValues = new Map<string, JsonValue>();
  private readonly nextClientSeq = new Map<string, number>();
  private nextServerSeq = 1;

  constructor(schema: DocumentSchema<S>) {
    for (const path of Object.keys(schema.definition) as Array<
      Extract<keyof S, string>
    >) {
      this.authoritativeValues.set(path, schema.definition[path].initialValue);
    }
  }

  /** Returns the current authoritative state and its server sequence. */
  snapshot(): DocumentSnapshot<S> {
    const data = Object.freeze(
      Object.fromEntries(this.authoritativeValues)
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
      batch.operations.map((operation) => Object.freeze({ ...operation }))
    ) as readonly DocumentOperation<S>[];
    const nextAuthoritativeValues = new Map(this.authoritativeValues);
    applyOperations(nextAuthoritativeValues, operations);

    const commit: ServerCommit<DocumentOperation<S>> = Object.freeze({
      serverSeq: this.nextServerSeq,
      source: Object.freeze({ clientId: batch.clientId, seq: batch.seq }),
      operations,
    });

    this.authoritativeValues = nextAuthoritativeValues;
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
