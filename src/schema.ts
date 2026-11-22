import type { ListSnapshotData } from "./list.ts";
import type { MapSnapshotData } from "./map.ts";
import type { TextSnapshotData } from "./text.ts";
import { validateJsonValue } from "./json.ts";
import { checkPayload, type PayloadOf, type PayloadSchema } from "./payload.ts";

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ValueSchema<T extends JsonValue = JsonValue> {
  readonly kind: "value";
  readonly initialValue: T;
  /** Validates every value written, locally and on the server. */
  readonly payload?: PayloadSchema<T>;
}

declare const listValueType: unique symbol;

export interface ListSchema<T extends JsonValue = JsonValue> {
  readonly kind: "list";
  readonly [listValueType]?: T;
  /** Validates every element value inserted or set, locally and on the server. */
  readonly payload?: PayloadSchema<T>;
}

export interface TextSchema {
  readonly kind: "text";
}

declare const mapValueType: unique symbol;

export interface MapSchema<T extends JsonValue = JsonValue> {
  readonly kind: "map";
  readonly [mapValueType]?: T;
  /** Validates every value set, locally and on the server. */
  readonly payload?: PayloadSchema<T>;
}

export type CollectionSchema = ValueSchema | ListSchema | TextSchema | MapSchema;

export type SchemaShape = Record<string, CollectionSchema>;

export class DocumentSchema<S extends SchemaShape> {
  readonly definition: Readonly<S>;

  constructor(definition: S) {
    this.definition = Object.freeze({ ...definition });
  }
}

/**
 * Defines an immutable JSON-compatible value in a document schema. With a Standard Schema, the
 * initial value and every value written are validated, locally and on the server.
 */
export function value(initialValue: string): ValueSchema<string>;
export function value(initialValue: number): ValueSchema<number>;
export function value(initialValue: boolean): ValueSchema<boolean>;
export function value(initialValue: null): ValueSchema<null>;
export function value<T extends JsonValue>(initialValue: T): ValueSchema<T>;
export function value<S extends PayloadSchema>(initialValue: PayloadOf<S>, schema: S): ValueSchema<PayloadOf<S>>;
export function value<T extends JsonValue>(initialValue: T, schema?: PayloadSchema<T>): ValueSchema<T> {
  validateJsonValue(initialValue, ["initialValue"]);
  if (schema === undefined) return Object.freeze({ kind: "value", initialValue });
  requirePayloadSchema(schema);
  checkPayload(schema, initialValue, ["initialValue"]);
  return Object.freeze({ kind: "value", initialValue, payload: schema });
}

/**
 * Defines an initially empty list of immutable JSON-compatible values. With a Standard Schema,
 * every value inserted or set is validated, locally and on the server.
 */
export function list<T extends JsonValue>(): ListSchema<T>;
export function list<S extends PayloadSchema>(schema: S): ListSchema<PayloadOf<S>>;
export function list<T extends JsonValue>(schema?: PayloadSchema<T>): ListSchema<T> {
  if (schema === undefined) return Object.freeze({ kind: "list" });
  requirePayloadSchema(schema);
  return Object.freeze({ kind: "list", payload: schema });
}

/**
 * Defines an initially empty map from string keys to immutable JSON-compatible values. With a
 * Standard Schema, every value set is validated, locally and on the server.
 */
export function map<T extends JsonValue>(): MapSchema<T>;
export function map<S extends PayloadSchema>(schema: S): MapSchema<PayloadOf<S>>;
export function map<T extends JsonValue>(schema?: PayloadSchema<T>): MapSchema<T> {
  if (schema === undefined) return Object.freeze({ kind: "map" });
  requirePayloadSchema(schema);
  return Object.freeze({ kind: "map", payload: schema });
}

function requirePayloadSchema(schema: unknown): void {
  const props = (typeof schema === "object" || typeof schema === "function") && schema !== null &&
    "~standard" in schema ? schema["~standard"] : undefined;
  if (typeof props !== "object" || props === null || !("version" in props) || props.version !== 1 ||
    !("validate" in props) || typeof props.validate !== "function") {
    throw new TypeError("A payload schema must implement Standard Schema v1");
  }
}

/** Defines an initially empty collaborative plain-text string. */
export function text(): TextSchema {
  return Object.freeze({ kind: "text" });
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

export type MapType<D> = D extends MapSchema<infer T> ? T : never;

/** The JSON data saved for one collection descriptor. */
export type SnapshotType<D> = D extends ValueSchema<infer T>
  ? T
  : D extends ListSchema<infer T>
    ? ListSnapshotData<T>
    : D extends TextSchema
      ? TextSnapshotData
      : D extends MapSchema<infer T>
        ? MapSnapshotData<T>
        : never;
