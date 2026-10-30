// @ts-check
import { decodeCursor } from "../../dist/index.js";
import { readHttpResponse } from "../http-sync-controller.js";

/** @typedef {import("./binding.js").CursorSelection} CursorSelection */
/** @typedef {{ readonly clientId: string, readonly seq: number, readonly selection: CursorSelection | null }} PresenceEntry */

/** @param {unknown} input @param {string} name @returns {Record<string, unknown>} */
function record(input, name) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error(name + " must be an object");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Checked to be a plain object above.
  return /** @type {Record<string, unknown>} */ (input);
}

/** Validates relayed presence; cursors are untrusted wire data like batches and commits.
 * @param {unknown} input @returns {CursorSelection | null}
 */
function decodeSelection(input) {
  if (input === null) return null;
  const { from, to } = record(input, "Presence selection");
  return { from: decodeCursor(from), to: decodeCursor(to) };
}

/**
 * Example-only best-effort presence over the text editor host's relay. Nothing is saved, and failures
 * never touch the document: presence only describes where other writers' cursors are.
 * @param {{ url: string, clientId: string, fetch?: typeof globalThis.fetch }} options
 */
export function createPresenceChannel(options) {
  const fetch = options.fetch ?? globalThis.fetch;
  /** @type {CursorSelection | null | undefined} */
  let queued;
  /** @type {Promise<void> | undefined} */
  let sending;

  async function send() {
    try {
      while (queued !== undefined) {
        const selection = queued;
        queued = undefined;
        await readHttpResponse(options.url, fetch, "/presence", 204, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: options.clientId, selection }),
        });
      }
    } finally { sending = undefined; }
  }

  return {
    /** Shares the latest selection. While a request is in flight, only the newest selection is kept.
     * @param {CursorSelection | null} selection
     */
    publish(selection) {
      queued = selection;
      sending ??= send();
      return sending;
    },
    /** Other writers' latest selections, validated. @returns {Promise<PresenceEntry[]>} */
    async poll() {
      /** @type {unknown} */
      const input = JSON.parse(await readHttpResponse(options.url, fetch, "/presence", 200));
      const { entries } = record(input, "Presence response");
      if (!Array.isArray(entries)) throw new Error("Presence entries must be an array");
      return entries.map((entry) => {
        const { clientId, seq, selection } = record(entry, "Presence entry");
        if (typeof clientId !== "string" || typeof seq !== "number" || !Number.isSafeInteger(seq)) {
          throw new Error("Invalid presence entry");
        }
        return { clientId, seq, selection: decodeSelection(selection) };
      }).filter((entry) => entry.clientId !== options.clientId);
    },
  };
}
