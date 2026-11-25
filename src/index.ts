export {
  counter,
  counterMap,
  defineDocument,
  DocumentSchema,
  list,
  map,
  text,
  value,
  type CollectionSchema,
  type CounterMapSchema,
  type CounterSchema,
  type JsonPrimitive,
  type JsonValue,
  type ListSchema,
  type ListType,
  type MapSchema,
  type MapType,
  type SchemaShape,
  type TextSchema,
  type BlockConfig,
  type BlockShape,
  type MarkConfig,
  type MarkExpand,
  type MarkShape,
  type MarkValue,
  type ValueSchema,
  type ValueType,
} from "./schema.ts";

export {
  type List,
  type ListChange,
  type ListChangeEvent,
  type ListDeleteOperation,
  type ListInsertOperation,
  type ListMoveEntry,
  type ListMoveOperation,
  type ListSetOperation,
  type ListOperation,
  type ListSnapshotData,
  type SavedIdRange,
} from "./list.ts";

export {
  type MapChange,
  type MapChangeEvent,
  type MapCollection,
  type MapDeleteOperation,
  type MapOperation,
  type MapSetOperation,
  type MapSnapshotData,
} from "./map.ts";

export {
  type Counter,
  type CounterAddOperation,
  type CounterMap,
  type CounterMapAddOperation,
  type CounterMapChange,
  type CounterMapChangeEvent,
  type CounterMapDeleteOperation,
  type CounterMapOperation,
  type CounterMapSnapshotData,
} from "./counter.ts";

export {
  type Text,
  type TextChange,
  type TextChangeEvent,
  type TextDeleteOperation,
  type TextIdRange,
  type TextInsertOperation,
  type TextMarkOperation,
  type TextBlockOperation,
  type TextBlock,
  type TextBlockChange,
  type TextBlockEntry,
  type TextOperation,
  type TextSnapshotData,
  type TextFormatChange,
  type TextAttributesOf,
  type TextDeltaOp,
} from "./text.ts";
export type { TextMark, TextAttributes } from "./marks.ts";

export {
  ClientDocument,
  createClient,
  createServer,
  ServerDocument,
  type ChangeEvent,
  type DiscardEvent,
  type TransformEvent,
  type BatchOutcome,
  type TrackedChange,
  type ClientBatch,
  type ClientBatchRef,
  type ClientCheckpoint,
  type CreateClientOptions,
  type CreateServerOptions,
  type DocumentOperation,
  type DocumentSnapshot,
  type DocumentSnapshotData,
  type DocumentState,
  type LocalChangeEvent,
  type Operation,
  type PendingReplayConflict,
  type ServerChangeEvent,
  type ServerClientSession,
  type ServerCheckpoint,
  type ServerCommit,
  type ServerReceipt,
  type ServerReplayEntry,
  type ServerResolveContext,
  type ServerResolver,
  type Value,
  type ValueSetOperation,
} from "./runtime.ts";

export { type Cursor } from "./cursor.ts";

export {
  decodeClientBatch,
  decodeCursor,
  decodeClientCheckpoint,
  decodeServerCheckpoint,
  decodeServerCommit,
  decodeSnapshot,
  WireDecodeError,
} from "./wire.ts";

export { assertClientBatchNamespace } from "./namespace.ts";
export { CollectionConflictError } from "./conflict.ts";
export { createUndoManager, type UndoManager, type UndoManagerOptions } from "./undo.ts";
export {
  PayloadValidationError,
  type PayloadOf,
  type PayloadSchema,
  type StandardSchemaV1,
  type StandardSchemaV1Issue,
  type StandardSchemaV1Props,
  type StandardSchemaV1Result,
} from "./payload.ts";
