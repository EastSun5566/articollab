// @ts-check
import { connectSync, createHttpTransport } from "../../dist/sync/index.js";
import { Board } from "../browser-http-smoke/smoke.js";
import { createTextEditor } from "./editor.js";
import { createPresenceChannel } from "./presence.js";

const PRESENCE_INTERVAL = 1000;
/** Republish an unchanged selection before the relay's 15-second expiry. */
const PRESENCE_HEARTBEAT = 5000;

/** Presence is best-effort: failures are shown on the pane and never stop the editors.
 * @param {{presenceStatus: HTMLParagraphElement}} pane @param {unknown} error */
function presenceFailed(pane, error) {
  pane.presenceStatus.textContent = "Presence unavailable: " + (error instanceof Error ? error.message : String(error));
}

/** @param {readonly import("./binding.js").RemoteStatus[]} statuses @param {readonly string[]} labels */
function describePresence(statuses, labels) {
  return labels.map((label) => {
    const status = statuses.find((entry) => entry.label === label);
    if (status === undefined) return label + " has not shared a position.";
    if (!status.resolved) return label + "'s position is in content this writer has not synced yet.";
    return status.from === status.to ? `${label}: caret at element ${status.from}.`
      : `${label}: selecting elements ${status.from}–${status.to}.`;
  }).join(" ");
}

/** @param {{details: HTMLPreElement, sync: {doc: {checkpoint(): unknown}}}} pane */
function inspect(pane) {
  try { pane.details.textContent = JSON.stringify(pane.sync.doc.checkpoint(), null, 2); }
  catch (error) { pane.details.textContent = "Checkpoint unavailable: " + String(error); }
  pane.details.hidden = false;
}

/** What a writer's status badge says, from its sync status and push channel.
 * @param {import("../../dist/sync/index.js").SyncStatus} status
 * @param {import("../../dist/sync/index.js").SyncPushState} push
 * @param {boolean} offline
 */
export function describeSync(status, push, offline) {
  if (status === "failed") return { state: "failed", text: "Failed" };
  if (status === "stopped") return { state: "stopped", text: "Stopped" };
  if (status === "gap") return { state: "failed", text: "History gap: preserve the checkpoint" };
  if (status === "blocked") return { state: "blocked", text: "Blocked by a rejected edit" };
  if (offline || status === "retrying") return { state: "offline", text: offline ? "Offline" : "Reconnecting" };
  if (status === "syncing") return { state: "syncing", text: "Syncing" };
  return push === "open" ? { state: "live", text: "Live" } : { state: "polling", text: "Polling" };
}

/**
 * A fetch whose writer can be taken offline: new requests fail like a dropped network, and open
 * event streams are aborted. Only stream requests are tracked; others finish on their own.
 * @param {typeof globalThis.fetch} [base]
 */
export function createOfflineSwitch(base = globalThis.fetch) {
  let offline = false;
  /** @type {Set<AbortController>} */
  const streams = new Set();
  /** @type {typeof globalThis.fetch} */
  const fetch = async (input, init) => {
    if (offline) throw new TypeError("Network unavailable (simulated offline)");
    const url = input instanceof Request ? input.url : input.toString();
    if (!url.includes("/events?")) return base(input, init);
    const controller = new AbortController();
    streams.add(controller);
    const signal = init?.signal;
    signal?.addEventListener("abort", () => { streams.delete(controller); controller.abort(); }, { once: true });
    return base(input, { ...init, signal: controller.signal });
  };
  return {
    fetch,
    get offline() { return offline; },
    /** @param {boolean} next */
    set(next) {
      offline = next;
      if (!next) return;
      for (const controller of streams) controller.abort();
      streams.clear();
    },
  };
}

/** Explicit mount keeps imports free of DOM, requests and writer registration.
 * @param {HTMLElement} root @param {string} url
 */
export async function mountTextEditors(root, url) {
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Opening two writer sessions…";
  const columns = document.createElement("div");
  columns.className = "editors";
  root.append(status, columns);
  /** @type {{sync: import("../../dist/sync/index.js").SyncClient<typeof Board.definition>,
   * editor: Awaited<ReturnType<typeof createTextEditor>>, details: HTMLPreElement,
   * presence: ReturnType<typeof createPresenceChannel>, presenceStatus: HTMLParagraphElement,
   * polling: boolean, published: number, cleanup: () => void}[]} */
  const panes = [];
  let destroyed = false, failed = false;
  /** @type {unknown} */
  let failure;
  /** Writer labels by client ID, for naming remote carets. @type {Map<string, string>} */
  const labels = new Map();
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;

  /** A binding failure stops the page; the sync clients keep their checkpoints. @param {unknown} error */
  function stop(error) {
    if (!failed) { failed = true; failure = error; }
    // stop() can run inside a failing editor transaction; reconfigure only after it unwinds.
    for (const pane of panes) { pane.sync.stop(); queueMicrotask(() => { pane.editor.setReadOnly(true); }); }
    status.textContent = "Stopped: " + (failure instanceof Error ? failure.message : String(failure)) +
      ". Inspect and preserve the current checkpoints. Completed edits were not rolled back.";
    status.dataset.state = "error";
  }
  /** @param {(typeof panes)[number]} pane */
  function publish(pane) {
    if (destroyed || failed) return;
    pane.published = Date.now();
    try { pane.presence.publish(pane.editor.selectionCursors()).catch((error) => presenceFailed(pane, error)); }
    catch (error) { presenceFailed(pane, error); }
  }
  /** @param {(typeof panes)[number]} pane */
  async function poll(pane) {
    // Skip a tick rather than queue requests or redraw under an active input-method composition.
    if (destroyed || failed || pane.polling || pane.editor.isComposing()) return;
    pane.polling = true;
    try {
      const entries = await pane.presence.poll();
      if (destroyed || failed) return;
      pane.editor.setRemote(entries.flatMap(({ clientId, selection }) => selection === null ? []
        : [{ label: labels.get(clientId) ?? clientId, selection }]));
    } catch (error) { presenceFailed(pane, error); }
    finally { pane.polling = false; }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearInterval(timer);
    // Best-effort: hide this page's carets now instead of after the relay expiry.
    for (const pane of panes) pane.presence.publish(null).catch(() => {});
    for (const pane of panes) { pane.sync.stop(); pane.cleanup(); pane.editor.destroy(); }
  }
  try {
    for (const label of ["A", "B"]) {
      const network = createOfflineSwitch();
      const sync = await connectSync(Board, { pollInterval: 1000,
        transport: createHttpTransport({ url: new URL("/sync/", url), fetch: network.fetch }) });
      if (destroyed) { sync.stop(); break; }
      const clientId = sync.doc.checkpoint().clientId;
      const section = document.createElement("section");
      const heading = document.createElement("h2");
      heading.textContent = "Writer " + label;
      const badge = document.createElement("span");
      badge.className = "badge";
      heading.append(" ", badge);
      const identity = document.createElement("p");
      identity.className = "identity";
      identity.textContent = clientId;
      const parent = document.createElement("div");
      parent.className = "editor";
      const message = document.createElement("p");
      message.className = "message";
      message.setAttribute("aria-live", "polite");
      const controls = document.createElement("div");
      controls.className = "controls";
      const offlineLabel = document.createElement("label");
      const offline = document.createElement("input");
      offline.type = "checkbox";
      offlineLabel.append(offline, " Offline");
      const discard = document.createElement("button"), show = document.createElement("button");
      discard.type = show.type = "button";
      discard.textContent = "Discard blocked edits"; show.textContent = "Inspect checkpoint";
      discard.hidden = true;
      const details = document.createElement("pre");
      details.hidden = true;
      const presenceStatus = document.createElement("p");
      presenceStatus.className = "presence";
      presenceStatus.setAttribute("aria-live", "polite");
      presenceStatus.textContent = "Waiting for other writers' positions…";
      controls.append(offlineLabel, discard, show);
      section.append(heading, identity, parent, presenceStatus, controls, message, details);
      columns.append(section);
      const index = panes.length;
      labels.set(clientId, "Writer " + label);
      const others = ["A", "B"].filter((other) => other !== label).map((other) => "Writer " + other);

      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let refreshing;
      let readOnly = true; // createTextEditor starts read-only until the writer is ready.
      // Status and push events never arrive inside an editor transaction, but local edits do:
      // only these events change the editor, and only after the current dispatch has finished.
      function syncChanged() {
        refresh();
        const next = failed || ["blocked", "gap", "failed", "stopped"].includes(sync.status);
        if (next === readOnly) return;
        readOnly = next;
        queueMicrotask(() => { if (!destroyed) editor?.setReadOnly(readOnly); });
      }
      // checkpoint() copies the document, so the pending count is refreshed at most every 250 ms.
      function refresh() {
        const shown = describeSync(sync.status, sync.push, network.offline);
        badge.textContent = shown.text;
        badge.dataset.state = shown.state;
        discard.hidden = sync.status !== "blocked";
        if (sync.status === "failed") {
          message.textContent = "Sync failed: " + (sync.error instanceof Error ? sync.error.message : String(sync.error)) +
            ". Inspect and preserve the checkpoint.";
          return;
        }
        refreshing ??= setTimeout(() => {
          refreshing = undefined;
          const pending = sync.doc.checkpoint().pendingBatches.length;
          message.textContent = pending === 0 ? "All edits are saved on the server."
            : `${pending} ${pending === 1 ? "edit is" : "edits are"} waiting to be sent.`;
        }, 250);
      }
      /** @type {Awaited<ReturnType<typeof createTextEditor>> | undefined} */
      let editor;
      editor = await createTextEditor(parent, sync.doc, {
        label: "Writer " + label + " text",
        canEdit: () => !destroyed && !failed && sync.status !== "failed" && sync.status !== "gap",
        onError: stop, onComposition() {},
        onLocalEdit() { details.hidden = true; refresh(); },
        onSelection() { const pane = panes[index]; if (pane !== undefined) publish(pane); },
        onRemote(statuses) {
          const text = describePresence(statuses, others);
          if (presenceStatus.textContent !== text) presenceStatus.textContent = text; // Avoid live-region repeats.
        },
      });
      const stopStatus = sync.on("status", syncChanged), stopPush = sync.on("push", syncChanged);
      const onOffline = () => {
        network.set(offline.checked);
        refresh();
        if (!offline.checked) sync.sync().catch(() => {}); // Like the browser's online event.
      };
      const onDiscard = () => { sync.rejectPending().catch(() => {}).finally(syncChanged); };
      const onShow = () => { const pane = panes[index]; if (pane !== undefined) inspect(pane); };
      offline.addEventListener("change", onOffline); discard.addEventListener("click", onDiscard); show.addEventListener("click", onShow);
      panes.push({ sync, editor, details,
        presence: createPresenceChannel({ url, clientId }), presenceStatus, polling: false, published: 0,
        cleanup() {
          stopStatus(); stopPush();
          clearTimeout(refreshing);
          offline.removeEventListener("change", onOffline); discard.removeEventListener("click", onDiscard); show.removeEventListener("click", onShow);
        },
      });
      syncChanged();
    }
    if (!destroyed) {
      for (const pane of panes) publish(pane);
      timer = setInterval(() => {
        for (const pane of panes) {
          if (Date.now() - pane.published >= PRESENCE_HEARTBEAT) publish(pane);
          void poll(pane);
        }
      }, PRESENCE_INTERVAL);
      status.textContent = "Ready. Type in either writer; edits are sent and received automatically.";
    }
  } catch (error) { stop(error); }
  return { destroy };
}
