// @ts-check
// IndexedDB checkpoints for the browser examples: one store key per document and writer label.
import { CheckpointLockedError, openIndexedDbStore } from "../../dist/sync/index.js";

/** The server's document identity. Stored checkpoints are keyed by it, so a restarted server starts fresh.
 * @param {string} url */
export async function readDocumentId(url) {
  const response = await fetch(new URL("/document", url));
  /** @type {unknown} */
  const body = response.ok ? await response.json() : undefined;
  if (typeof body !== "object" || body === null || !("documentId" in body) || typeof body.documentId !== "string") {
    throw new Error("The server did not report a document ID");
  }
  return body.documentId;
}

/** The key of one slot: slot 0 is the base key, slot n is `<key>#n`.
 * @param {string} documentId @param {string} label @param {number} [slot] */
function storeKey(documentId, label, slot = 0) {
  const key = `${documentId}:${label}`;
  return slot === 0 ? key : `${key}#${slot}`;
}

/**
 * Opens a free slot for one writer, preferring one a closed tab left unsent edits in, or returns
 * undefined when other tabs hold every slot.
 * @param {{ database: string, documentId: string, label: string, slots: number }} options
 */
export async function openWriterStore({ database, documentId, label, slots }) {
  try {
    return await openIndexedDbStore({ database, key: storeKey(documentId, label), slots });
  } catch (error) {
    if (error instanceof CheckpointLockedError) return undefined;
    throw error;
  }
}

/**
 * Clears every slot of every label that no other tab holds. Stop this page's writers first, so
 * their locks are released.
 * @param {{ database: string, documentId: string, labels: readonly string[], slots: number }} options
 */
export async function clearWriterStores({ database, documentId, labels, slots }) {
  for (const label of labels) {
    for (let slot = 0; slot < slots; slot++) {
      try {
        const store = await openIndexedDbStore({ database, key: storeKey(documentId, label, slot) });
        try { await store.clear(); } finally { store.close(); }
      } catch (error) {
        if (!(error instanceof CheckpointLockedError)) throw error;
      }
    }
  }
}
