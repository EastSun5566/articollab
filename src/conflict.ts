/** Internal state-dependent failure, distinct from malformed operations. */
export class CollectionConflictError extends Error {}

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
