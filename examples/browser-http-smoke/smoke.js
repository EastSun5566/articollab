// @ts-check
import {
  createClient, decodeClientCheckpoint, decodeServerCommit, decodeSnapshot,
  defineDocument, list, text, value,
} from "articollab";
import { createHttpSyncController, readHttpResponse, readClientRegistration } from "../http-sync-controller.js";

export const Board = defineDocument({
  count: value(0),
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- Pins string elements for independent tsc --checkJs; lint inference is not the contract.
  items: /** @type {import("articollab").ListSchema<string>} */ (list()),
  body: text(),
});
/** @typedef {typeof Board.definition} Shape */
/** @typedef {import("articollab").ClientDocument<Shape>} Client */
/** @typedef {import("articollab").ClientCheckpoint<Shape>} Checkpoint */
/** @typedef {import("articollab").DocumentSnapshot<Shape>} Snapshot */

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function check(condition, message) { if (!condition) throw new Error(message); }
/** @param {unknown} input */
function encoded(input) {
  return JSON.stringify(input, (_key, /** @type {unknown} */ entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
}
/** @param {unknown} actual @param {unknown} expected @param {string} message */
function same(actual, expected, message) { check(encoded(actual) === encoded(expected), message); }

/** Browser-only initialization; the manual synchronization loop is shared with Node.
 * @param {string} url
 * @param {{fetch?: typeof globalThis.fetch, checkpoint?: Checkpoint,
 *   saveClientCheckpoint?: (checkpoint: Checkpoint) => undefined}} [options]
 */
export async function connectBrowserHttpClient(url, options = {}) {
  const fetch = options.fetch ?? globalThis.fetch;
  const registration = options.checkpoint === undefined ? await readClientRegistration(url, fetch) : undefined;
  const initial = options.checkpoint === undefined
    ? { snapshot: decodeSnapshot(Board, registration?.snapshot) }
    : { checkpoint: options.checkpoint };
  const clientId = options.checkpoint?.clientId ?? registration?.clientId;
  if (clientId === undefined) throw new Error("Missing client registration");
  const doc = createClient(Board, { clientId, ...initial,
    onBatch() { saveClient(); }, // Save offline pending; no automatic submission.
  });
  const controller = createHttpSyncController({ url, fetch,
    checkpoint: () => doc.checkpoint(), receive: (commit) => doc.receive(commit),
    decodeCommit: (input) => decodeServerCommit(Board, input),
    isBlocked: () => doc.replayConflict !== null, saveClient,
  });
  function saveClient() {
    controller.requireUsable();
    try { options.saveClientCheckpoint?.(doc.checkpoint()); }
    catch (error) { throw controller.stop(error); }
  }
  saveClient(); // Save fresh/restored state before returning the connection.
  return { doc, sync: () => controller.sync(), rejectPending: () => controller.rejectPending() };
}

/** @param {Client} doc */
function view(doc) {
  const saved = doc.checkpoint();
  const conflict = doc.replayConflict;
  return { count: doc.state.count.value, items: doc.state.items.toArray(), body: doc.state.body.toString(),
    codePoints: doc.state.body.length, watermark: saved.snapshot.serverSeq,
    pending: saved.pendingBatches.map((batch) => batch.seq), lastLocalSeq: saved.lastLocalSeq,
    lastBunchSeqs: saved.lastBunchSeqs,
    conflict: conflict === null ? null : { seq: conflict.batch.seq, operationIndex: conflict.operationIndex, message: conflict.message },
  };
}
/** @param {Snapshot} saved */
function serverView(saved) {
  return { serverSeq: saved.serverSeq, count: saved.data.count, items: saved.data.items.values, body: saved.data.body.value };
}

/**
 * Run three bounded scenarios. No server object or delivery shortcut is available here.
 * @param {string} url @param {{fetch?: typeof globalThis.fetch}} [options]
 */
export async function runBrowserHttpSmoke(url, options = {}) {
  const fetch = options.fetch ?? globalThis.fetch;
  /** @param {Checkpoint} [checkpoint] */
  function connect(checkpoint) {
    return connectBrowserHttpClient(url, { fetch, ...(checkpoint === undefined ? {} : { checkpoint }) });
  }
  async function snapshot() {
    return decodeSnapshot(Board, JSON.parse(await readHttpResponse(url, fetch, "/snapshot", 200)));
  }
  /** @param {string} name @param {string[]} clientIds */
  function report(name, clientIds) {
    /** @type {{label: string, server: ReturnType<typeof serverView>, a: ReturnType<typeof view>, b: ReturnType<typeof view>}[]} */
    const stages = [];
    return { name, clientIds, stages };
  }
  /** @param {ReturnType<typeof report>} result @param {string} label @param {Client} a @param {Client} b */
  async function record(result, label, a, b) {
    result.stages.push({ label, server: serverView(await snapshot()), a: view(a), b: view(b) });
  }
  /** @param {Client[]} clients */
  async function converged(clients) {
    const saved = await snapshot();
    for (const doc of clients) {
      same(doc.checkpoint().pendingBatches, [], "converged client still has pending");
      check(doc.replayConflict === null, "converged client is still blocked");
      same(doc.checkpoint().snapshot, saved, "authoritative snapshots diverged");
      same({ count: doc.state.count.value, items: doc.state.items.toArray(), body: doc.state.body.toString() },
        { count: saved.data.count, items: saved.data.items.values, body: saved.data.body.value }, "visible state diverged");
    }
    return saved;
  }

  const mixed = report("Mixed optimistic edits and HTTP catch-up", []);
  {
    const a = await connect();
    const b = await connect();
    mixed.clientIds.push(a.doc.checkpoint().clientId, b.doc.checkpoint().clientId);
    const baseline = await snapshot();
    await record(mixed, "Fresh HTTP snapshots", a.doc, b.doc);
    let ownChanges = 0;
    a.doc.on("change", (event) => { if (event.origin === "server") ownChanges++; });
    a.doc.transact(() => {
      a.doc.state.count.value = baseline.data.count + 1;
      a.doc.state.items.push("A");
      a.doc.state.body.insert(a.doc.state.body.length, "A😀");
    });
    b.doc.transact(() => {
      b.doc.state.count.value = baseline.data.count + 2;
      b.doc.state.items.push("Peer");
      b.doc.state.body.insert(b.doc.state.body.length, "B");
    });
    check(a.doc.state.count.value === baseline.data.count + 1 && b.doc.state.count.value === baseline.data.count + 2,
      "local mixed values were not optimistic");
    // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
    check(a.doc.state.body.length === [...baseline.data.body.value].length + 2, "emoji was not one code point");
    same(await snapshot(), baseline, "local edits submitted automatically");
    await record(mixed, "Both clients optimistic; server unchanged", a.doc, b.doc);
    check(await a.sync(), "source sync failed");
    check(ownChanges === 0, "accepted own commit emitted an extra change");
    await record(mixed, "First source acknowledged; peer still pending", a.doc, b.doc);
    check(await b.sync(), "peer sync failed");
    check(await a.sync(), "remote catch-up failed");
    const final = await converged([a.doc, b.doc]);
    check(final.data.count === baseline.data.count + 2, "server order did not select the peer value");
    check(final.data.items.values.length === baseline.data.items.values.length + 2, "concurrent list insert was lost");
    // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
    check([...final.data.body.value].length === [...baseline.data.body.value].length + 3, "concurrent text insert was lost");
    await record(mixed, "Converged through ordered HTTP acknowledgements", a.doc, b.doc);
  }

  const restored = report("JSON checkpoint restore over HTTP", []);
  {
    let a = await connect();
    const b = await connect();
    restored.clientIds.push(a.doc.checkpoint().clientId, b.doc.checkpoint().clientId);
    const baseline = await snapshot();
    a.doc.transact(() => {
      a.doc.state.items.push("Temporary");
      a.doc.state.body.insert(a.doc.state.body.length, "T😀");
    });
    check(await a.sync() && await b.sync(), "tombstone setup failed");
    a.doc.transact(() => {
      a.doc.state.items.delete(baseline.data.items.values.length);
      // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
      a.doc.state.body.delete([...baseline.data.body.value].length, 2);
    });
    check(await a.sync() && await b.sync(), "tombstone deletion failed");
    same((await snapshot()).data.items.values, baseline.data.items.values, "temporary list value remained");
    same((await snapshot()).data.body.value, baseline.data.body.value, "temporary text remained");
    a.doc.transact(() => {
      a.doc.state.count.value = baseline.data.count + 3;
      a.doc.state.items.push("Restored");
      a.doc.state.body.insert(a.doc.state.body.length, "R😀");
    });
    await record(restored, "Tombstones saved; mixed pending not submitted", a.doc, b.doc);
    const checkpoint = decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(a.doc.checkpoint())));
    const before = view(a.doc);
    a = await connect(checkpoint); // Retire the old writer; no pump is running.
    same(a.doc.checkpoint(), checkpoint, "restored checkpoint changed");
    same(view(a.doc), before, "restore changed optimistic state or ID progress");
    await record(restored, "New writer hydrated from JSON checkpoint", a.doc, b.doc);
    check(await a.sync() && await b.sync(), "restored pending did not sync");
    a.doc.transact(() => {
      a.doc.state.count.value = baseline.data.count + 4;
      a.doc.state.items.push("After restore");
      a.doc.state.body.insert(a.doc.state.body.length, "!");
    });
    check(await a.sync() && await b.sync(), "restored writer could not keep editing");
    const final = await converged([a.doc, b.doc]);
    check(final.data.count === baseline.data.count + 4, "restored edit was lost");
    check(a.doc.checkpoint().lastLocalSeq === checkpoint.lastLocalSeq + 1, "local sequence did not continue");
    await record(restored, "Pending drained; later IDs and sequences accepted", a.doc, b.doc);
  }

  const rejected = report("HTTP rejection and blocked recovery", []);
  {
    const a = await connect();
    const b = await connect();
    rejected.clientIds.push(a.doc.checkpoint().clientId, b.doc.checkpoint().clientId);
    const baseline = await snapshot();
    a.doc.transact(() => {
      a.doc.state.count.value = baseline.data.count + 1;
      a.doc.state.items.push("Discarded");
      a.doc.state.body.insert(a.doc.state.body.length, "X😀");
    });
    a.doc.transact(() => {
      a.doc.state.items.push("Dependent");
      a.doc.state.body.insert(a.doc.state.body.length, "Dependent");
    });
    a.doc.state.count.value = baseline.data.count + 9;
    b.doc.transact(() => {
      b.doc.state.count.value = baseline.data.count + 5;
      b.doc.state.items.push("Recovery peer");
      b.doc.state.body.insert(b.doc.state.body.length, "Peer");
    });
    check(await b.sync(), "recovery peer sync failed");
    await record(rejected, "Dependent mixed pending and an unseen peer commit", a.doc, b.doc);
    check(!(await a.sync()), "rejected insertion did not block its dependent suffix");
    check(a.doc.replayConflict?.batch.seq === 2, "conflict did not identify the dependent batch");
    same(a.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [2, 3], "blocked pending was lost");
    await record(rejected, "First insertion rejected; dependent suffix blocked", a.doc, b.doc);
    check(await a.rejectPending(), "HTTP cancellation failed");
    check(await b.sync(), "peer missed cancellation commits");
    await converged([a.doc, b.doc]);
    await record(rejected, "Original pending range confirmed without undo", a.doc, b.doc);
    a.doc.transact(() => {
      a.doc.state.count.value = baseline.data.count + 6;
      a.doc.state.items.push("Recovered");
      a.doc.state.body.insert(a.doc.state.body.length, "Hi😀");
    });
    check(await a.sync() && await b.sync(), "editing did not resume after cancellation");
    const final = await converged([a.doc, b.doc]);
    check(final.data.count === baseline.data.count + 6, "recovered edit was lost");
    check(final.data.items.values.length === baseline.data.items.values.length + 2, "cancelled list effects survived");
    // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
    check([...final.data.body.value].length === [...baseline.data.body.value].length + 7, "cancelled text effects survived");
    await record(rejected, "Recovered writer and peer converged", a.doc, b.doc);
  }
  return [mixed, restored, rejected];
}
