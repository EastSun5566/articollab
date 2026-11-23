/**
 * An operation that is well formed but cannot apply to the current state, such as an unknown List
 * anchor or a Counter total outside the safe integer range. `server.receive()` throws it and leaves
 * the server unchanged; a client's replay records it as `replayConflict` instead.
 */
export class CollectionConflictError extends Error {
  override readonly name = "CollectionConflictError";
}

/** Preserves the location of an unexpected pending replay failure. */
export class PendingReplayError extends Error {
  readonly batchIndex: number;
  readonly operationIndex: number;

  constructor(batchIndex: number, operationIndex: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.batchIndex = batchIndex;
    this.operationIndex = operationIndex;
  }
}
