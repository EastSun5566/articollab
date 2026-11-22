// @ts-check
import { connectSync, createHttpTransport } from "../../dist/sync/index.js";
import { Board } from "../browser-http-smoke/smoke.js";
import { createTextEditor } from "./editor.js";
import { selectionOf, selectionSchema } from "./presence.js";
import { createOfflineSwitch, describeSync } from "../sync-ui.js";

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
  /** @type {{sync: import("../../dist/sync/index.js").PresenceSyncClient<typeof Board.definition,
   *   import("./presence.js").SelectionPresence>,
   * editor: Awaited<ReturnType<typeof createTextEditor>>, details: HTMLPreElement, cleanup: () => void}[]} */
  const panes = [];
  let destroyed = false, failed = false;
  /** @type {unknown} */
  let failure;
  /** Writer labels by client ID, for naming remote carets. @type {Map<string, string>} */
  const labels = new Map();

  /** A binding failure stops the page; the sync clients keep their checkpoints. @param {unknown} error */
  function stop(error) {
    if (!failed) { failed = true; failure = error; }
    // stop() can run inside a failing editor transaction; reconfigure only after it unwinds.
    for (const pane of panes) { pane.sync.stop(); queueMicrotask(() => { pane.editor.setReadOnly(true); }); }
    status.textContent = "Stopped: " + (failure instanceof Error ? failure.message : String(failure)) +
      ". Inspect and preserve the current checkpoints. Completed edits were not rolled back.";
    status.dataset.state = "error";
  }
  /** Shares the pane's main selection as cursors; the sync client re-sends it so it does not expire.
   * @param {(typeof panes)[number]} pane */
  function publish(pane) {
    if (destroyed || failed) return;
    try { pane.sync.presence.set({ selection: pane.editor.selectionCursors() }); }
    catch (error) { stop(error); }
  }
  /** Draws the other writers' selections, but not under an active input-method composition.
   * @param {(typeof panes)[number]} pane */
  function showPeers(pane) {
    if (destroyed || failed || pane.editor.isComposing()) return;
    pane.editor.setRemote([...pane.sync.presence.peers].flatMap(([clientId, state]) => {
      const selection = selectionOf(state);
      return selection === null ? [] : [{ label: labels.get(clientId) ?? clientId, selection }];
    }));
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    // stop() also tells the other writers this one left, so its caret disappears at once.
    for (const pane of panes) { pane.sync.stop(); pane.cleanup(); pane.editor.destroy(); }
  }
  try {
    for (const label of ["A", "B"]) {
      const network = createOfflineSwitch();
      const sync = await connectSync(Board, { pollInterval: 1000, presence: { schema: selectionSchema },
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
        onError: stop,
        // Peers that changed during a composition are drawn once it ends.
        onComposition() { const pane = panes[index]; if (pane !== undefined) showPeers(pane); },
        onLocalEdit() { details.hidden = true; refresh(); },
        onSelection() { const pane = panes[index]; if (pane !== undefined) publish(pane); },
        onRemote(statuses) {
          const text = describePresence(statuses, others);
          if (presenceStatus.textContent !== text) presenceStatus.textContent = text; // Avoid live-region repeats.
        },
      });
      const stopStatus = sync.on("status", syncChanged), stopPush = sync.on("push", syncChanged);
      const stopPeers = sync.presence.on("change", () => { const pane = panes[index]; if (pane !== undefined) showPeers(pane); });
      const onOffline = () => {
        network.set(offline.checked);
        refresh();
        if (!offline.checked) sync.sync().catch(() => {}); // Like the browser's online event.
      };
      const onDiscard = () => { sync.rejectPending().catch(() => {}).finally(syncChanged); };
      const onShow = () => { const pane = panes[index]; if (pane !== undefined) inspect(pane); };
      offline.addEventListener("change", onOffline); discard.addEventListener("click", onDiscard); show.addEventListener("click", onShow);
      panes.push({ sync, editor, details,
        cleanup() {
          stopStatus(); stopPush(); stopPeers();
          clearTimeout(refreshing);
          offline.removeEventListener("change", onOffline); discard.removeEventListener("click", onDiscard); show.removeEventListener("click", onShow);
        },
      });
      syncChanged();
    }
    if (!destroyed) {
      for (const pane of panes) { publish(pane); showPeers(pane); }
      status.textContent = "Ready. Type in either writer; edits are sent and received automatically.";
    }
  } catch (error) { stop(error); }
  return { destroy };
}
