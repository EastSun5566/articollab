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

export interface ClientBatch<TOperation extends Operation = Operation> {
  readonly clientId: string;
  readonly seq: number;
  readonly operations: readonly TOperation[];
}

export interface ChangeEvent<TOperation extends Operation = Operation> {
  readonly origin: "local";
  readonly batch: ClientBatch<TOperation>;
}

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
 * This first slice emits local batches only. Receiving server commits and
 * replaying pending batches will be layered onto the same API later.
 */
export class ClientDocument<S extends SchemaShape> {
  readonly state: DocumentState<S>;

  private readonly clientId: string;
  private readonly onBatch: CreateClientOptions<S>["onBatch"];
  private readonly listeners = new Set<ChangeListener<S>>();
  private readonly values = new Map<string, RuntimeValue<JsonValue>>();

  private nextSeq = 1;
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

    this.onBatch(batch);

    const event: ChangeEvent<DocumentOperation<S>> = Object.freeze({
      origin: "local",
      batch,
    });
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
