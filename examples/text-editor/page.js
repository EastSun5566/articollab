// @ts-check
import { connectBrowserHttpClient } from "../browser-http-smoke/smoke.js";
import { createTextEditor } from "./editor.js";
import { createEditorActions } from "./actions.js";

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
   * cleanup: () => void}[]} */
  const panes = [];
  /** @type {ReturnType<typeof createEditorActions> | undefined} */
  let actions;
  let destroyed = false, failed = false;
  /** @type {unknown} */
  let failure;

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

  function destroy() {
    if (destroyed) return;
    destroyed = true;
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
      controls.append(sync, reject, show);
      section.append(heading, identity, parent, controls, message, details);
      columns.append(section);
      const index = panes.length;
      const editor = await createTextEditor(parent, connection.doc, {
        label: "Writer " + label + " text",
        canEdit: () => !destroyed && !failed && actions !== undefined && !actions.busy,
        onError: stop, onComposition: buttons,
        onLocalEdit() { message.textContent = "Local edits are pending. Nothing is sent until Sync."; details.hidden = true; },
      });
      const onSync = () => { void run(index, "sync"); };
      const onReject = () => { void run(index, "rejectPending"); };
      const onShow = () => inspect(index);
      sync.addEventListener("click", onSync); reject.addEventListener("click", onReject); show.addEventListener("click", onShow);
      panes.push({ connection, editor, message, details, sync, reject,
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
    if (!destroyed) status.textContent = "Ready. Edit either writer, then sync A, B, A to converge.";
    buttons();
  } catch (error) { stop(error); }
  return { destroy };
}
