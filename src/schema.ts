import type { ListSnapshotData } from "./list.ts";
import type { MapSnapshotData } from "./map.ts";
import type { TextSnapshotData } from "./text.ts";
import type { CounterMapSnapshotData } from "./counter.ts";
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

/** Whether text typed at a mark's start ("before"), end ("after"), both or neither takes the mark. */
export type MarkExpand = "none" | "before" | "after" | "both";

export interface MarkConfig<T extends JsonValue = JsonValue> {
  readonly expand: MarkExpand;
  /** Validates every value set, locally and on the server; `null` removes the mark and is never validated. */
  readonly payload?: PayloadSchema<T>;
}

export type MarkShape = Readonly<Record<string, MarkConfig>>;

/** The value type of one mark: its payload schema's type, or any JSON value. */
export type MarkValue<C> = C extends { readonly payload: infer P } ? PayloadOf<P> : JsonValue;

declare const textMarkType: unique symbol;

export interface TextSchema<M extends MarkShape = {}> {
  readonly kind: "text";
  readonly [textMarkType]?: M;
  /** The formatting marks this Text accepts, by key. */
  readonly marks?: M;
}

declare const mapValueType: unique symbol;

export interface MapSchema<T extends JsonValue = JsonValue> {
  readonly kind: "map";
  readonly [mapValueType]?: T;
  /** Validates every value set, locally and on the server. */
  readonly payload?: PayloadSchema<T>;
}

export interface CounterSchema {
  readonly kind: "counter";
  /** A safe integer. */
  readonly initialValue: number;
}

export interface CounterMapSchema {
  readonly kind: "counterMap";
}

export type CollectionSchema = ValueSchema | ListSchema | TextSchema<MarkShape> | MapSchema | CounterSchema | CounterMapSchema;

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

/**
 * Defines an integer that writers add to rather than set, so concurrent additions all count.
 * `initialValue` and every total must be safe integers.
 */
export function counter(initialValue = 0): CounterSchema {
  if (typeof initialValue !== "number") throw new TypeError(`A counter's initial value must be a number: ${String(initialValue)}`);
  if (!Number.isSafeInteger(initialValue)) {
    throw new RangeError(`A counter's initial value must be a safe integer: ${String(initialValue)}`);
  }
  return Object.freeze({ kind: "counter", initialValue });
}

/** Defines an initially empty set of counters by string key; an absent key counts as 0. */
export function counterMap(): CounterMapSchema {
  return Object.freeze({ kind: "counterMap" });
}

const EXPANDS: readonly string[] = ["none", "before", "after", "both"];

/**
 * Defines an initially empty collaborative string. With `marks`, ranges of it can be formatted:
 * each mark key has an `expand` rule and an optional Standard Schema for its values.
 */
export function text(): TextSchema;
export function text<const M extends MarkShape>(options: { readonly marks: M }): TextSchema<M>;
export function text(options?: { readonly marks: MarkShape }): TextSchema {
  if (options === undefined) return Object.freeze({ kind: "text" });
  if (typeof options !== "object" || options === null) throw new TypeError("Text options must be an object");
  const { marks } = options;
  if (typeof marks !== "object" || marks === null || Array.isArray(marks)) throw new TypeError("Text marks must be an object");
  const entries = Object.keys(marks).map((key) => {
    if (key.length === 0) throw new Error("Mark keys must not be empty");
    const config: unknown = marks[key];
    if (typeof config !== "object" || config === null) throw new TypeError(`Mark ${key} must be an object`);
    const { expand, payload } = config as Partial<MarkConfig>;
    if (typeof expand !== "string" || !EXPANDS.includes(expand)) {
      throw new TypeError(`Mark ${key} expand must be "none", "before", "after" or "both"`);
    }
    if (payload === undefined) return [key, Object.freeze({ expand })] as const;
    requirePayloadSchema(payload);
    return [key, Object.freeze({ expand, payload })] as const;
  });
  return Object.freeze({ kind: "text", marks: Object.freeze(Object.fromEntries(entries)) });
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
        : D extends CounterSchema
          ? number
          : D extends CounterMapSchema
            ? CounterMapSnapshotData
            : never;
