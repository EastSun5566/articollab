import type { ListSnapshotData } from "./list.ts";

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ValueSchema<T extends JsonValue = JsonValue> {
  readonly kind: "value";
  readonly initialValue: T;
}

declare const listValueType: unique symbol;

export interface ListSchema<T extends JsonValue = JsonValue> {
  readonly kind: "list";
  readonly [listValueType]?: T;
}

export type CollectionSchema = ValueSchema | ListSchema;

export type SchemaShape = Record<string, CollectionSchema>;

export class DocumentSchema<S extends SchemaShape> {
  readonly definition: Readonly<S>;

  constructor(definition: S) {
    this.definition = Object.freeze({ ...definition });
  }
}

/** Defines an immutable JSON-compatible value in a document schema. */
export function value(initialValue: string): ValueSchema<string>;
export function value(initialValue: number): ValueSchema<number>;
export function value(initialValue: boolean): ValueSchema<boolean>;
export function value(initialValue: null): ValueSchema<null>;
export function value<T extends JsonValue>(initialValue: T): ValueSchema<T>;
export function value<T extends JsonValue>(initialValue: T): ValueSchema<T> {
  return Object.freeze({ kind: "value", initialValue });
}

/** Defines an initially empty list of immutable JSON-compatible values. */
export function list<T extends JsonValue>(): ListSchema<T> {
  return Object.freeze({ kind: "list" }) as ListSchema<T>;
}

/** Defines the fixed schema shared by every copy of a document. */
export function defineDocument<const S extends SchemaShape>(
  definition: S
): DocumentSchema<S> {
  for (const key of Object.keys(definition)) {
    if (key.length === 0) {
      throw new Error("Document schema keys must not be empty");
    }
  }

  return new DocumentSchema(definition);
}

export type ValueType<D> = D extends ValueSchema<infer T> ? T : never;

export type ListType<D> = D extends ListSchema<infer T> ? T : never;

/** The JSON data saved for one collection descriptor. */
export type SnapshotType<D> = D extends ValueSchema<infer T>
  ? T
  : D extends ListSchema<infer T>
    ? ListSnapshotData<T>
    : never;
