// @ts-check
import {
  createClient, createServer, decodeClientBatch, decodeClientCheckpoint,
  decodeServerCheckpoint, decodeServerCommit, decodeSnapshot,
  defineDocument, list, text, value,
} from "articula";

const Board = defineDocument({
  count: value(0),
  items: /** @type {import("articula").ListSchema<string>} */ (list()),
  body: text(),
});
/** @typedef {typeof Board.definition} Shape */
/** @typedef {import("articula").ClientDocument<Shape>} Client */
/** @typedef {import("articula").ClientCheckpoint<Shape>} Checkpoint */
/** @typedef {import("articula").ClientBatch<import("articula").DocumentOperation<Shape>>} Batch */

/** @param {unknown} input @returns {unknown} */
function json(input) { return JSON.parse(JSON.stringify(input)); }

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function check(condition, message) { if (!condition) throw new Error(message); }

/** @param {unknown} input */
function encoded(input) {
  return JSON.stringify(input, (_key, entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
}
/** @param {unknown} actual @param {unknown} expected @param {string} message */
function same(actual, expected, message) { check(encoded(actual) === encoded(expected), message); }

/** @param {Client} doc */
function visible(doc) {
  return { count: doc.state.count.value, items: doc.state.items.toArray(), body: doc.state.body.toString() };
}
/** @param {Client} doc */
function view(doc) {
  const saved = doc.checkpoint();
  const conflict = doc.replayConflict;
  return { ...visible(doc), codePoints: doc.state.body.length, watermark: saved.snapshot.serverSeq,
    pending: saved.pendingBatches.map((batch) => batch.seq), lastLocalSeq: saved.lastLocalSeq,
    lastBunchSeqs: saved.lastBunchSeqs,
    conflict: conflict === null ? null : { seq: conflict.batch.seq, operationIndex: conflict.operationIndex, message: conflict.message } };
}

function newPair() {
  /** @type {{a: Batch[], b: Batch[]}} */
  const emitted = { a: [], b: [] };
  const serverChanges = { a: 0, b: 0 };
  /** @type {import("articula").ServerResolver<Shape>} */
  const resolve = ({ batch }) => batch.operations;
  const server = createServer(Board, { resolve });
  /** @param {"a" | "b"} id @param {Checkpoint} [checkpoint] */
  function client(id, checkpoint) {
    const doc = createClient(Board, { clientId: id,
      ...(checkpoint === undefined ? { snapshot: decodeSnapshot(Board, json(server.snapshot())) } : { checkpoint }),
      onBatch(batch) { emitted[id].push(decodeClientBatch(Board, json(batch))); } });
    doc.on("change", (event) => { if (event.origin === "server") serverChanges[id]++; });
    return doc;
  }
  return { server, resolve, client, emitted, serverChanges, a: client("a"), b: client("b") };
}
/** @typedef {ReturnType<typeof newPair>} Pair */

/** @param {Pair} pair @param {"a" | "b"} id @param {boolean} [reject] */
function submit(pair, id, reject = false) {
  const batch = pair[id].checkpoint().pendingBatches[0];
  check(batch !== undefined, "submission needs the earliest pending batch");
  const input = decodeClientBatch(Board, json(batch));
  const receipt = reject ? pair.server.reject(input) : pair.server.receive(input);
  check(!receipt.replayed, "new submission must create one commit");
  return decodeServerCommit(Board, json(receipt.commit));
}
/** @param {Pair} pair @param {"a" | "b"} id */
function catchUp(pair, id) {
  const commits = pair.server.commitsSince(pair[id].checkpoint().snapshot.serverSeq);
  check(commits !== null, "smoke history must cover the client watermark");
  for (const commit of commits) pair[id].receive(decodeServerCommit(Board, json(commit)));
}
/** @param {Pair} pair */
function converged(pair) {
  const snapshot = pair.server.snapshot();
  for (const doc of [pair.a, pair.b]) {
    same(doc.checkpoint().pendingBatches, [], "converged client still has pending");
    check(doc.replayConflict === null, "converged client is still blocked");
    same(doc.checkpoint().snapshot, snapshot, "authoritative snapshots differ");
    same(visible(doc), { count: snapshot.data.count, items: snapshot.data.items.values, body: snapshot.data.body.value },
      "visible state differs from authoritative data");
  }
}
/** @param {Pair} pair @param {string} label */
function stage(pair, label) {
  const snapshot = pair.server.snapshot();
  return { label, server: { watermark: snapshot.serverSeq, count: snapshot.data.count,
    items: snapshot.data.items.values, body: snapshot.data.body.value,
    tombstones: { items: snapshot.data.items.idList.filter((range) => range.isDeleted).reduce((sum, range) => sum + range.count, 0),
      body: snapshot.data.body.idList.filter((range) => range.isDeleted).reduce((sum, range) => sum + range.count, 0) } },
    a: view(pair.a), b: view(pair.b) };
}
/** @typedef {(label: string) => void} RecordStage */

/** @param {Pair} pair @param {RecordStage} record */
function optimistic(pair, record) {
  record("Two fresh clients");
  pair.a.transact(() => { pair.a.state.count.value = 1; pair.a.state.items.push("A"); pair.a.state.body.insert(0, "A😀"); });
  pair.b.transact(() => { pair.b.state.count.value = 2; pair.b.state.items.push("B"); pair.b.state.body.insert(0, "B"); });
  same(visible(pair.a), { count: 1, items: ["A"], body: "A😀" }, "A must be immediately optimistic");
  same(visible(pair.b), { count: 2, items: ["B"], body: "B" }, "B must be immediately optimistic");
  check(pair.a.state.body.length === 2 && pair.a.state.body.toString().length === 3, "Text must count code points");
  same([...pair.a.state.body], ["A", "😀"], "Text iteration must yield code points");
  check(pair.emitted.a[0].operations.length === 3 && pair.emitted.b[0].operations.length === 3, "mixed edits must form one batch");
  record("Both mixed edits are optimistic; nothing submitted");
  submit(pair, "a");
  same(pair.a.checkpoint().pendingBatches.map((batch) => batch.seq), [1], "submission alone is not an ack");
  record("Server accepted A; delivery delayed");
  catchUp(pair, "b");
  check(pair.b.state.count.value === 2, "B pending Value must replay over remote A");
  same(pair.b.checkpoint().pendingBatches.map((batch) => batch.seq), [1], "remote A must not confirm B");
  record("B received A while retaining its own pending");
  catchUp(pair, "a");
  check(pair.serverChanges.a === 0, "ordinary own ack must be silent");
  const before = pair.serverChanges.b;
  submit(pair, "b");
  catchUp(pair, "a");
  catchUp(pair, "b");
  check(pair.serverChanges.b === before, "B own ack must also be silent");
  converged(pair);
  record("Both clients converged after ordered catch-up");
}

/** @param {Pair} pair @param {RecordStage} record */
function restoration(pair, record) {
  record("Fresh lineage");
  pair.a.transact(() => { pair.a.state.count.value = 5; pair.a.state.items.push("Old"); pair.a.state.body.insert(0, "old😀"); });
  submit(pair, "a"); catchUp(pair, "a"); catchUp(pair, "b");
  pair.a.transact(() => { pair.a.state.count.value = 6; pair.a.state.items.delete(0); pair.a.state.body.delete(0, 4); });
  submit(pair, "a"); catchUp(pair, "a"); catchUp(pair, "b");
  pair.a.transact(() => { pair.a.state.count.value = 7; pair.a.state.items.push("Pending"); pair.a.state.body.insert(0, "Hello 😀"); });
  pair.a.state.count.value = 8;
  record("Authoritative tombstones with mixed pending work");
  const saved = pair.a.checkpoint();
  check(saved.snapshot.data.items.idList.some((range) => range.isDeleted), "List tombstones must be saved");
  check(saved.snapshot.data.body.idList.some((range) => range.isDeleted), "Text tombstones must be saved");
  const before = visible(pair.a);
  const emitted = pair.emitted.a.length;
  const changes = pair.serverChanges.a;
  const serverSaved = pair.server.checkpoint();
  pair.server = createServer(Board, { resolve: pair.resolve, checkpoint: decodeServerCheckpoint(Board, json(serverSaved)) });
  pair.a = pair.client("a", decodeClientCheckpoint(Board, json(saved)));
  pair.b = pair.client("b", decodeClientCheckpoint(Board, json(pair.b.checkpoint())));
  same(pair.server.checkpoint(), serverSaved, "server checkpoint must survive JSON restore");
  same(pair.a.checkpoint(), saved, "client checkpoint must survive JSON restore");
  same(visible(pair.a), before, "restore must rebuild the optimistic view");
  check(pair.emitted.a.length === emitted && pair.serverChanges.a === changes, "restore must be silent");
  record("New objects restored from JSON; old objects retired");
  catchUp(pair, "a");
  while (pair.a.checkpoint().pendingBatches.length > 0) { submit(pair, "a"); catchUp(pair, "a"); }
  catchUp(pair, "b");
  converged(pair);
  record("Restored pending batches acknowledged in order");
  pair.a.transact(() => { pair.a.state.items.push("After restore"); pair.a.state.body.insert(pair.a.state.body.length, "!"); });
  const next = pair.a.checkpoint();
  check(next.lastLocalSeq === saved.lastLocalSeq + 1, "local sequence must continue after restore");
  check(next.lastBunchSeqs.items > saved.lastBunchSeqs.items && next.lastBunchSeqs.body > saved.lastBunchSeqs.body,
    "restored generators must allocate fresh bunches");
  submit(pair, "a"); catchUp(pair, "a"); catchUp(pair, "b");
  converged(pair);
  record("New edits preserve allocation progress and converge");
}

/** @param {Pair} pair @param {RecordStage} record */
function rejection(pair, record) {
  record("Fresh lineage");
  pair.a.transact(() => { pair.a.state.count.value = 1; pair.a.state.items.push("A"); pair.a.state.body.insert(0, "😀"); });
  pair.a.transact(() => { pair.a.state.count.value = 2; pair.a.state.items.push("B"); pair.a.state.body.insert(1, "B"); });
  pair.a.state.count.value = 9;
  pair.b.transact(() => { pair.b.state.count.value = 4; pair.b.state.items.push("Peer"); pair.b.state.body.insert(0, "p"); });
  record("Insertion, dependent mixed suffix and peer edit pending");
  submit(pair, "b");
  const rejected = submit(pair, "a", true);
  same(rejected.operations, [], "explicit rejection must have no authoritative effect");
  catchUp(pair, "a"); catchUp(pair, "b");
  check(pair.a.replayConflict?.batch.seq === 2, "dependent suffix must be blocked");
  same(visible(pair.a), { count: 4, items: ["Peer"], body: "p" }, "failed mixed batch must not apply partial changes");
  same(pair.a.checkpoint().pendingBatches, pair.emitted.a.slice(1), "original blocked pending must be retained");
  record("Rejected insertion blocks the suffix without discarding it");
  const saved = pair.a.checkpoint();
  const conflict = pair.a.replayConflict;
  const emitted = pair.emitted.a.length;
  pair.a = pair.client("a", decodeClientCheckpoint(Board, json(saved)));
  same(pair.a.checkpoint(), saved, "blocked checkpoint must restore unchanged");
  same(pair.a.replayConflict, conflict, "restore must derive the same conflict");
  check(pair.emitted.a.length === emitted, "restore must not submit blocked work");
  record("Blocked client restored from JSON");
  const cutoff = pair.a.checkpoint().lastLocalSeq;
  while (true) {
    const batch = pair.a.checkpoint().pendingBatches[0];
    if (batch === undefined || batch.seq > cutoff) break;
    submit(pair, "a", true);
    catchUp(pair, "a");
    check(pair.a.checkpoint().pendingBatches[0]?.seq !== batch.seq, "rejection must confirm the target batch");
    record("Cancelled pending batch " + batch.seq);
  }
  catchUp(pair, "b");
  converged(pair);
  same(visible(pair.a), { count: 4, items: ["Peer"], body: "p" }, "cancellation must not undo the accepted peer edit");
  pair.a.transact(() => { pair.a.state.count.value = 10; pair.a.state.items.push("Recovered"); pair.a.state.body.insert(1, "😀"); });
  check(pair.a.checkpoint().lastLocalSeq === cutoff + 1, "recovery must preserve local sequence progress");
  submit(pair, "a"); catchUp(pair, "a"); catchUp(pair, "b");
  converged(pair);
  record("Editing resumed; both clients converged");
}

/** @param {string} name @param {(pair: Pair, record: RecordStage) => void} run */
function runCase(name, run) {
  const pair = newPair();
  /** @type {ReturnType<typeof stage>[]} */
  const stages = [];
  let phase = "start";
  try {
    run(pair, (label) => { phase = label; stages.push(stage(pair, label)); });
    return { name, stages };
  } catch (cause) {
    throw new Error(name + " / after " + phase + ": " + (cause instanceof Error ? cause.message : String(cause)), { cause });
  }
}

/** Runs three fresh, synchronous scenarios. Importing this module does not run them or touch the DOM. */
export function runBrowserSmoke() {
  return [runCase("Optimistic edits and delayed delivery", optimistic),
    runCase("JSON checkpoint restore", restoration), runCase("Rejection and blocked recovery", rejection)];
}
