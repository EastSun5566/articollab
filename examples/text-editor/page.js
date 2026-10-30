// @ts-check
import { connectBrowserHttpClient } from "../browser-http-smoke/smoke.js";
import { createTextEditor } from "./editor.js";
import { createEditorActions } from "./actions.js";
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
  /** @type {{connection: Awaited<ReturnType<typeof connectBrowserHttpClient>>,
   * editor: Awaited<ReturnType<typeof createTextEditor>>, message: HTMLParagraphElement,
   * details: HTMLPreElement, sync: HTMLButtonElement, reject: HTMLButtonElement,
   * presence: ReturnType<typeof createPresenceChannel>, presenceStatus: HTMLParagraphElement,
   * polling: boolean, published: number, cleanup: () => void}[]} */
  const panes = [];
  /** @type {ReturnType<typeof createEditorActions> | undefined} */
  let actions;
  let destroyed = false, failed = false;
  /** @type {unknown} */
  let failure;
  /** Writer labels by client ID, for naming remote carets. @type {Map<string, string>} */
  const labels = new Map();
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;

  function buttons() {
    const disabled = destroyed || failed || actions === undefined || actions.busy || panes.some((pane) => pane.editor.isComposing());
    for (const pane of panes) { pane.sync.disabled = disabled; pane.reject.disabled = disabled; }
  }
  /** @param {unknown} error */
  function stop(error) {
    if (!failed) { failed = true; failure = error; }
    actions?.stop(failure);
    status.textContent = "Stopped: " + (failure instanceof Error ? failure.message : String(failure)) +
      ". Inspect and preserve the current checkpoints. Completed edits were not rolled back.";
    status.dataset.state = "error";
    buttons();
  }
  /** @param {number} index */
  function inspect(index) {
    const pane = panes[index];
    if (pane === undefined) return;
    try { pane.details.textContent = JSON.stringify(pane.connection.doc.checkpoint(), null, 2); }
    catch (error) { pane.details.textContent = "Checkpoint unavailable: " + String(error); }
    pane.details.hidden = false;
  }
  /** @param {number} index @param {"sync" | "rejectPending"} method */
  async function run(index, method) {
    const pane = panes[index];
    if (actions === undefined || pane === undefined || destroyed) return;
    if (actions.busy || panes.some((entry) => entry.editor.isComposing())) return;
    try {
      const result = actions.run(index, method);
      buttons();
      status.textContent = "Synchronizing writer " + (index === 0 ? "A" : "B") + "… Editing is paused.";
      const complete = await result;
      const checkpoint = pane.connection.doc.checkpoint();
      pane.message.textContent = `Watermark ${checkpoint.snapshot.serverSeq}; pending [${checkpoint.pendingBatches.map((batch) => batch.seq).join(", ")}]. ` +
        (pane.connection.doc.replayConflict === null ? "No replay conflict." : "Replay is blocked. Reject pending can confirm cancellation.");
      status.textContent = complete ? "Action completed. Sync the other writer to catch up." : "Action incomplete; pending is preserved. Inspect the checkpoint.";
      if (!pane.details.hidden) inspect(index);
    } catch (error) { stop(error); }
    finally { buttons(); }
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
    for (const pane of panes) { pane.cleanup(); pane.editor.destroy(); }
    buttons();
  }
  try {
    for (const label of ["A", "B"]) {
      const connection = await connectBrowserHttpClient(url);
      if (destroyed) break;
      const checkpoint = connection.doc.checkpoint();
      const section = document.createElement("section");
      const heading = document.createElement("h2");
      heading.textContent = "Writer " + label;
      const identity = document.createElement("p");
      identity.className = "identity";
      identity.textContent = checkpoint.clientId;
      const parent = document.createElement("div");
      parent.className = "editor";
      const message = document.createElement("p");
      message.className = "message";
      message.textContent = `Watermark ${checkpoint.snapshot.serverSeq}; no local edits yet.`;
      const controls = document.createElement("div");
      controls.className = "controls";
      const sync = document.createElement("button"), reject = document.createElement("button"), show = document.createElement("button");
      sync.type = reject.type = show.type = "button";
      sync.textContent = "Sync"; reject.textContent = "Reject pending"; show.textContent = "Inspect checkpoint";
      const details = document.createElement("pre");
      details.hidden = true;
      const presenceStatus = document.createElement("p");
      presenceStatus.className = "presence";
      presenceStatus.setAttribute("aria-live", "polite");
      presenceStatus.textContent = "Waiting for other writers' positions…";
      controls.append(sync, reject, show);
      section.append(heading, identity, parent, presenceStatus, controls, message, details);
      columns.append(section);
      const index = panes.length;
      labels.set(checkpoint.clientId, "Writer " + label);
      const others = ["A", "B"].filter((other) => other !== label).map((other) => "Writer " + other);
      const editor = await createTextEditor(parent, connection.doc, {
        label: "Writer " + label + " text",
        canEdit: () => !destroyed && !failed && actions !== undefined && !actions.busy,
        onError: stop, onComposition: buttons,
        onLocalEdit() { message.textContent = "Local edits are pending. Nothing is sent until Sync."; details.hidden = true; },
        onSelection() { const pane = panes[index]; if (pane !== undefined) publish(pane); },
        onRemote(statuses) {
          const text = describePresence(statuses, others);
          if (presenceStatus.textContent !== text) presenceStatus.textContent = text; // Avoid live-region repeats.
        },
      });
      const onSync = () => { void run(index, "sync"); };
      const onReject = () => { void run(index, "rejectPending"); };
      const onShow = () => inspect(index);
      sync.addEventListener("click", onSync); reject.addEventListener("click", onReject); show.addEventListener("click", onShow);
      panes.push({ connection, editor, message, details, sync, reject,
        presence: createPresenceChannel({ url, clientId: checkpoint.clientId }), presenceStatus, polling: false, published: 0,
        cleanup() {
          sync.removeEventListener("click", onSync); reject.removeEventListener("click", onReject); show.removeEventListener("click", onShow);
        },
      });
    }
    actions = createEditorActions(panes.map((pane) => ({
      sync: pane.connection.sync, rejectPending: pane.connection.rejectPending,
      isComposing: pane.editor.isComposing, setReadOnly: (value) => pane.editor.setReadOnly(value),
      isBlocked: () => pane.connection.doc.replayConflict !== null,
    })));
    for (const pane of panes) pane.editor.setReadOnly(pane.connection.doc.replayConflict !== null);
    if (!destroyed) {
      for (const pane of panes) publish(pane);
      timer = setInterval(() => {
        for (const pane of panes) {
          if (Date.now() - pane.published >= PRESENCE_HEARTBEAT) publish(pane);
          void poll(pane);
        }
      }, PRESENCE_INTERVAL);
    }
    if (!destroyed) status.textContent = "Ready. Edit either writer, then sync A, B, A to converge.";
    buttons();
  } catch (error) { stop(error); }
  return { destroy };
}
