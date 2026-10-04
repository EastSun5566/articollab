// @ts-check
import { decodeClientCheckpoint } from "articollab";
import { Board, connectBrowserHttpClient } from "../browser-http-smoke/smoke.js";

/** @typedef {import("articollab").ClientCheckpoint<typeof Board.definition>} Checkpoint */
/** @typedef {Pick<Storage, "getItem" | "setItem">} CheckpointStorage */
const key = "articollab:browser-reload-recovery:checkpoint";

/** One complete checkpoint per page session; this is not a writer lock.
 * @param {CheckpointStorage} storage
 */
export function createSessionCheckpointStore(storage) {
  return {
    load() {
      const message = storage.getItem(key);
      return message === null ? null : decodeClientCheckpoint(Board, JSON.parse(message));
    },
    /** @param {Checkpoint} checkpoint @returns {undefined} */
    save(checkpoint) {
      const message = JSON.stringify(checkpoint); // Serialize completely before replacing storage.
      storage.setItem(key, message);
    },
  };
}

/** Restore before any request, or save a fresh identity after fetching the snapshot.
 * @param {string} url
 * @param {{storage?: CheckpointStorage, fetch?: typeof globalThis.fetch}} [options]
 */
export async function connectPersistentBrowserClient(url, options = {}) {
  const store = createSessionCheckpointStore(options.storage ?? window.sessionStorage);
  const checkpoint = store.load();
  return connectBrowserHttpClient(url, checkpoint?.clientId ?? "browser-recovery-" + crypto.randomUUID(), {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(checkpoint === null ? {} : { checkpoint }),
    saveClientCheckpoint: store.save,
  });
}
