// @ts-check
import { createUndoManager } from "../../dist/index.js";
import { connectSync, createWebSocketTransport } from "../../dist/sync/index.js";
import { Note } from "./schema.js";
import { createRichEditor } from "./editor.js";
import { selectionOf, selectionSchema } from "../shared/presence.js";
import { createOfflineSwitch, describeSync } from "../shared/sync-ui.js";

/** @param {readonly import("./editor.js").RemoteStatus[]} statuses @param {readonly string[]} labels */
function describePresence(statuses, labels) {
  return labels.map((label) => {
    const status = statuses.find((entry) => entry.label === label);
    if (status === undefined) return label + " has not shared a position.";
    return status.resolved ? label + "'s caret is shown." : label + "'s position is in content this writer has not synced yet.";
  }).join(" ");
}

/** @param {{details: HTMLPreElement, sync: {doc: {checkpoint(): unknown}}}} pane */
function inspect(pane) {
  try { pane.details.textContent = JSON.stringify(pane.sync.doc.checkpoint(), null, 2); }
  catch (error) { pane.details.textContent = "Checkpoint unavailable: " + String(error); }
  pane.details.hidden = false;
}

/** Toolbar buttons: command, label, title. */
const TOOLS = /** @type {const} */ ([
  ["bold", "B", "Bold (Ctrl+B)"], ["italic", "I", "Italic (Ctrl+I)"], ["code", "Code", "Code (Ctrl+E)"], ["link", "Link", "Link (Ctrl+K)"],
  ["heading1", "H1", "Heading 1 (Ctrl+Alt+1)"], ["heading2", "H2", "Heading 2 (Ctrl+Alt+2)"], ["heading3", "H3", "Heading 3 (Ctrl+Alt+3)"],
  ["bullets", "• List", "Bullet list (Ctrl+Shift+8)"], ["numbers", "1. List", "Numbered list (Ctrl+Shift+7)"],
  ["quote", "Quote", "Quote"], ["codeBlock", "{ }", "Code block"], ["undo", "Undo", "Undo (Ctrl+Z)"], ["redo", "Redo", "Redo (Ctrl+Shift+Z)"],
]);

/** Mounts two writers into `root`, synced with the host at `url`.
 * @param {HTMLElement} root @param {string} url
 */
export async function mountRichEditors(root, url) {
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Opening two writer sessions…";
  const columns = document.createElement("div");
  columns.className = "editors";
  root.append(status, columns);
  /** @type {{sync: import("../../dist/sync/index.js").PresenceSyncClient<typeof Note.definition,
   *   import("../shared/presence.js").SelectionPresence>,
   * editor: Awaited<ReturnType<typeof createRichEditor>>, details: HTMLPreElement, cleanup: () => void,
   * history: import("../../dist/index.js").UndoManager}[]} */
  const panes = [];
  let destroyed = false, failed = false;
  const socketUrl = new URL("/sync/socket", url);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  /** @type {unknown} */
  let failure;
  /** Writer labels by client ID, for naming remote carets. @type {Map<string, string>} */
  const labels = new Map();

  /** A binding failure stops the page; the sync clients keep their checkpoints. @param {unknown} error */
  function stop(error) {
    if (!failed) { failed = true; failure = error; }
    for (const pane of panes) { pane.sync.close(); queueMicrotask(() => { pane.editor.setReadOnly(true); }); }
    status.textContent = "Stopped: " + (failure instanceof Error ? failure.message : String(failure)) +
      ". Inspect and preserve the current checkpoints. Completed edits were not rolled back.";
    status.dataset.state = "error";
  }
  /** Shares the pane's main selection as cursors. @param {(typeof panes)[number]} pane */
  function publish(pane) {
    if (destroyed || failed || pane.editor.isComposing()) return;
    try { pane.sync.presence.set({ selection: pane.editor.selectionCursors() }); }
    catch (error) { stop(error); }
  }
  /** Draws the other writers' selections, but not under an input-method composition.
   * @param {(typeof panes)[number]} pane @param {HTMLElement} presenceStatus @param {readonly string[]} others */
  function showPeers(pane, presenceStatus, others) {
    if (destroyed || failed || pane.editor.isComposing()) return;
    const statuses = pane.editor.setRemote([...pane.sync.presence.peers].flatMap(([clientId, state]) => {
      const selection = selectionOf(state);
      return selection === null ? [] : [{ label: labels.get(clientId) ?? clientId, selection }];
    }));
    const text = describePresence(statuses, others);
    if (presenceStatus.textContent !== text) presenceStatus.textContent = text;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const pane of panes) { pane.sync.close(); pane.cleanup(); pane.history.destroy(); pane.editor.destroy(); }
  }
  try {
    for (const label of ["A", "B"]) {
      const network = createOfflineSwitch();
      const sync = await connectSync(Note, { pollInterval: 1000, presence: { schema: selectionSchema },
        transport: createWebSocketTransport({ url: socketUrl, WebSocket: network.WebSocket }) });
      if (destroyed) { sync.close(); break; }
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
      const toolbar = document.createElement("div");
      toolbar.className = "toolbar";
      toolbar.setAttribute("role", "toolbar");
      toolbar.setAttribute("aria-label", "Writer " + label + " formatting");
      /** @type {Map<import("./editor.js").Command, HTMLButtonElement>} */
      const tools = new Map();
      for (const [name, text, title] of TOOLS) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.title = title;
        button.className = "tool-" + name;
        // Keep the editor's selection: a click would otherwise move focus first.
        button.addEventListener("mousedown", (event) => { event.preventDefault(); });
        tools.set(name, button);
        toolbar.append(button);
      }
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
      const unsent = document.createElement("pre");
      unsent.hidden = true;
      unsent.setAttribute("role", "alert");
      const presenceStatus = document.createElement("p");
      presenceStatus.className = "presence";
      presenceStatus.setAttribute("aria-live", "polite");
      presenceStatus.textContent = "Waiting for other writers' positions…";
      controls.append(offlineLabel, discard, show);
      section.append(heading, identity, toolbar, parent, presenceStatus, controls, message, unsent, details);
      columns.append(section);
      const index = panes.length;
      labels.set(clientId, "Writer " + label);
      const others = ["A", "B"].filter((other) => other !== label).map((other) => "Writer " + other);

      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let refreshing;
      let readOnly = true; // The editor starts read-only until the writer is ready.
      /** @type {Awaited<ReturnType<typeof createRichEditor>> | undefined} */
      let editor;
      function syncChanged() {
        refresh();
        const next = failed || ["blocked", "gap", "failed", "closed"].includes(sync.status);
        if (next === readOnly) return;
        readOnly = next;
        queueMicrotask(() => { if (!destroyed) editor?.setReadOnly(readOnly); });
      }
      // At most every 250 ms: checkpoint() copies the document.
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
      const history = createUndoManager(sync.doc, { paths: ["body"] });
      /** Runs a toolbar command or shortcut; undo throws while this writer's edits are blocked.
       * @param {import("./editor.js").Command} name */
      function command(name) {
        if (readOnly || editor === undefined || editor.isComposing()) return;
        try {
          if (name === "undo") history.undo();
          else if (name === "redo") history.redo();
          else if (name === "link") {
            const address = prompt("Link address (the server keeps only http: and https: links)", "https://");
            if (address !== null && address !== "" && !editor.link(address)) message.textContent = "Select some text first.";
          } else editor.run(name);
        } catch (error) { message.textContent = "Not changed: " + (error instanceof Error ? error.message : String(error)); }
        refresh();
      }
      editor = await createRichEditor(parent, sync.doc, {
        label: "Writer " + label + " text",
        canEdit: () => !destroyed && !failed && sync.status !== "failed" && sync.status !== "gap",
        onError: stop,
        onLocalEdit() { details.hidden = true; refresh(); },
        onSelection() { const pane = panes[index]; if (pane !== undefined) publish(pane); },
        onRemote() { const pane = panes[index]; if (pane !== undefined) queueMicrotask(() => { showPeers(pane, presenceStatus, others); }); },
        onCommand: command,
        // The confirmed text is its own undo step.
        onCompositionBoundary: () => { history.stopCapturing(); },
        onUnsentComposition(text) {
          unsent.hidden = false;
          unsent.textContent = "The composition could not be saved (" + sync.status + "). Copy the unsent text here:\n" + text;
        },
      });
      const toolClicks = [...tools].map(([name, button]) => {
        const listener = () => { command(name); };
        button.addEventListener("click", listener);
        return () => { button.removeEventListener("click", listener); };
      });
      const updateHistory = () => {
        tools.get("undo")?.toggleAttribute("disabled", !history.canUndo);
        tools.get("redo")?.toggleAttribute("disabled", !history.canRedo);
      };
      const stopHistory = history.on("change", updateHistory);
      updateHistory();
      const stopStatus = sync.on("status", syncChanged), stopPush = sync.on("push", syncChanged);
      const stopPeers = sync.presence.on("change", () => { const pane = panes[index]; if (pane !== undefined) showPeers(pane, presenceStatus, others); });
      const onOffline = () => {
        network.set(offline.checked);
        refresh();
        if (!offline.checked) sync.sync().catch(() => {}); // Like the browser's online event.
      };
      const onDiscard = () => { sync.rejectPending().catch(() => {}).finally(syncChanged); };
      const onShow = () => { const pane = panes[index]; if (pane !== undefined) inspect(pane); };
      offline.addEventListener("change", onOffline); discard.addEventListener("click", onDiscard); show.addEventListener("click", onShow);
      panes.push({ sync, editor, details, history,
        cleanup() {
          stopStatus(); stopPush(); stopPeers(); stopHistory();
          for (const removeClick of toolClicks) removeClick();
          clearTimeout(refreshing);
          offline.removeEventListener("change", onOffline); discard.removeEventListener("click", onDiscard); show.removeEventListener("click", onShow);
        },
      });
      syncChanged();
    }
    if (!destroyed) {
      for (const [index, pane] of panes.entries()) {
        publish(pane);
        const section = pane.details.parentElement, presence = section?.querySelector(".presence");
        if (presence instanceof HTMLElement) showPeers(pane, presence, index === 0 ? ["Writer B"] : ["Writer A"]);
      }
      status.textContent = "Ready.";
    }
  } catch (error) { stop(error); }
  return { destroy };
}
