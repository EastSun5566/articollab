// @ts-check
import { decodeClientCheckpoint } from "articollab";
import { Board, connectBrowserHttpClient } from "../browser-http-smoke/smoke.js";

/** @typedef {import("articollab").ClientCheckpoint<typeof Board.definition>} Checkpoint */
/** @typedef {{readonly documentId: string, readonly checkpoint: Checkpoint}} RecoveryCheckpoint */
/** @typedef {Pick<Storage, "getItem" | "setItem">} CheckpointStorage */
const key = "articollab:browser-reload-recovery:checkpoint";
const header = "X-Articollab-Document-Id";
/** @param {unknown} value @returns {value is string} */
function isDocumentId(value) {
  return typeof value === "string" && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/** One complete checkpoint per page session; this is not a writer lock.
 * @param {CheckpointStorage} storage
 */
export function createSessionCheckpointStore(storage) {
  return {
    load() {
      const message = storage.getItem(key);
      if (message === null) return null;
      /** @type {unknown} */
      const input = JSON.parse(message);
      if (input === null || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join(",") !== "checkpoint,documentId" ||
        !("documentId" in input) || !isDocumentId(input.documentId) || !("checkpoint" in input)) {
        throw new Error("Invalid recovery client envelope; document ID and checkpoint are required");
      }
      return Object.freeze({ documentId: input.documentId, checkpoint: decodeClientCheckpoint(Board, input.checkpoint) });
    },
    /** @param {RecoveryCheckpoint} record @returns {undefined} */
    save(record) {
      const message = JSON.stringify(record); // Serialize completely before replacing storage.
      storage.setItem(key, message);
    },
  };
}

/** Restore before any request, or register and save a fresh writer identity.
 * @param {string} url
 * @param {{storage?: CheckpointStorage, fetch?: typeof globalThis.fetch}} [options]
 */
export async function connectPersistentBrowserClient(url, options = {}) {
  const store = createSessionCheckpointStore(options.storage ?? window.sessionStorage);
  const record = store.load();
  const checkpoint = record?.checkpoint ?? null;
  let documentId = record?.documentId;
  const fetch = options.fetch ?? globalThis.fetch;
  /** @type {typeof globalThis.fetch} */
  async function guardedFetch(input, init) {
    const headers = new Headers(init?.headers);
    if (documentId !== undefined) headers.set(header, documentId);
    const response = await fetch(input, { ...init, headers });
    const received = response.headers.get(header);
    // Failed registration follows the wrapper's ordinary HTTP error path.
    if (documentId === undefined && response.status !== 201) return response;
    if (!isDocumentId(received) || (documentId !== undefined && received !== documentId)) {
      const error = new Error("Document lineage mismatch; preserve the recovery checkpoint");
      try { await response.body?.cancel(); }
      catch { /* Cleanup must not replace the identity failure. */ }
      throw error;
    }
    documentId = received;
    return response;
  }
  const connection = await connectBrowserHttpClient(url, {
    fetch: guardedFetch,
    ...(checkpoint === null ? {} : { checkpoint }),
    saveClientCheckpoint(nextCheckpoint) {
      if (documentId === undefined) throw new Error("Missing document ID");
      store.save({ documentId, checkpoint: nextCheckpoint });
    },
  });
  if (documentId === undefined) throw new Error("Missing document ID");
  return { ...connection, documentId };
}
