import { jsonPointer, type JsonPathSegment } from "./json.ts";
import type { JsonValue } from "./schema.ts";

/**
 * The Standard Schema v1 interface (https://standardschema.dev), copied as the specification
 * recommends so that zod, valibot, arktype and hand-written validators work without a dependency.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1Props<Input, Output>;
}

export interface StandardSchemaV1Props<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (value: unknown) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
  readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

export type StandardSchemaV1Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaV1Issue[] };

export interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

/** A schema for payloads of type `T`: its input type must be JSON. */
export type PayloadSchema<T extends JsonValue = JsonValue> = StandardSchemaV1<T, unknown>;

/** The payload type a schema accepts. */
export type PayloadOf<S> = S extends StandardSchemaV1<infer Input, unknown>
  ? Input extends JsonValue ? Input : never
  : never;

/** A payload that a collection's schema rejected, locally or on the server. */
export class PayloadValidationError extends TypeError {
  /** The collection path, and for a Map the key. */
  readonly path: readonly JsonPathSegment[];
  readonly issues: readonly StandardSchemaV1Issue[];

  constructor(path: readonly JsonPathSegment[], issues: readonly StandardSchemaV1Issue[]) {
    super(`Invalid payload at ${jsonPointer(path)}: ${issues[0]?.message ?? "rejected by its schema"}`);
    this.name = "PayloadValidationError";
    this.path = Object.freeze([...path]);
    this.issues = Object.freeze([...issues]);
  }
}

/** Throws unless `schema` accepts `value`; the value itself is kept, never the schema's output. */
export function checkPayload(
  schema: PayloadSchema | undefined, value: JsonValue, path: readonly JsonPathSegment[]
): void {
  if (schema === undefined) return;
  const result: unknown = schema["~standard"].validate(value);
  if (typeof result !== "object" || result === null) {
    throw new TypeError(`Payload schema at ${jsonPointer(path)} returned no result`);
  }
  if ("then" in result && typeof result.then === "function") {
    throw new TypeError(`Payload schema at ${jsonPointer(path)} must validate synchronously`);
  }
  if ("issues" in result && Array.isArray(result.issues)) {
    throw new PayloadValidationError(path, result.issues);
  }
}
