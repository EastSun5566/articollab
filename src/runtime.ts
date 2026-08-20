import type {
  DocumentSchema,
  JsonValue,
  SchemaShape,
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

export interface CreateClientOptions<S extends SchemaShape> {
  readonly clientId: string;
  readonly onBatch: (batch: ClientBatch<DocumentOperation<S>>) => void;
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

    const state: Partial<Record<keyof S, Value<JsonValue>>> = {};
    for (const path of Object.keys(schema.definition) as Array<
      Extract<keyof S, string>
    >) {
      const descriptor = schema.definition[path];
      const runtimeValue = new RuntimeValue(
        (mutationPath, value) => this.setValue(mutationPath, value),
        path,
        descriptor.initialValue
      );
      this.values.set(path, runtimeValue);
      this.authoritativeValues.set(path, descriptor.initialValue);
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
    this.applyOperations(nextAuthoritativeValues, commit.operations);

    const remainingBatches = isOwnCommit
      ? this.pendingBatches.slice(1)
      : this.pendingBatches;
    const nextOptimisticValues = new Map(nextAuthoritativeValues);
    for (const pending of remainingBatches) {
      this.applyOperations(nextOptimisticValues, pending.operations);
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

  private applyOperations(
    values: Map<string, JsonValue>,
    operations: readonly DocumentOperation<S>[]
  ): void {
    for (const operation of operations) {
      if (!values.has(operation.path)) {
        throw new Error(`Unknown document path: ${operation.path}`);
      }
      values.set(operation.path, operation.value);
    }
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

export function createClient<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  options: CreateClientOptions<S>
): ClientDocument<S> {
  return new ClientDocument(schema, options);
}
