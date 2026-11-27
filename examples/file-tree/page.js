// @ts-check
import { createUndoManager } from "articollab";
import { connectSync, createHttpTransport } from "articollab/sync";
import { createOfflineSwitch, describeSync } from "../shared/sync-ui.js";
import { clearWriterStores, openWriterStore, readDocumentId } from "../shared/writer-store.js";
import { selectionSchema } from "./presence.js";
import {
  childrenOf, createNode, deleteNode, describeTransform, isFolder, isWithin, moveNode, pathOf, renameNode, ROOT, Tree,
} from "./tree.js";

/** @typedef {import("articollab/sync").PresenceSyncClient<import("./tree.js").Shape,
 *   import("./presence.js").Selection>} TreeSync */

const DATABASE = "articollab-file-tree";
const LABELS = ["A", "B"];
/** Tabs that can run each writer at once; every tab is its own writer in a free slot. */
const SLOTS = 4;

/** @param {unknown} error */
function describeError(error) { return error instanceof Error ? error.message : String(error); }

/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [className] @param {string} [text] */
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {string} text */
function button(text) {
  const node = element("button", undefined, text);
  node.type = "button";
  return node;
}

/** The node of the tree row an event happened in. @param {Event} event */
function nodeOf(event) {
  const item = event.target instanceof Element ? event.target.closest("li[data-id]") : null;
  return item instanceof HTMLElement ? item.dataset.id : undefined;
}

/** Mounts two writers into `root`, synced with the host at `url`.
 * @param {HTMLElement} root @param {string} url */
export async function mountFileTree(root, url) {
  const status = element("p", undefined, "Opening two writer sessions…");
  status.setAttribute("role", "status");
  const clear = button("Clear saved edits and reload");
  const writers = element("div", "writers");
  root.append(status, clear, writers);
  /** @type {(() => void)[]} */
  const stops = [];
  /** Writer names by client ID, for showing who selected what. @type {Map<string, string>} */
  const names = new Map();
  let destroyed = false;
  /** @type {string | undefined} */
  let documentId;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const stop of stops) stop();
  }
  // Stopping the writers releases their locks; a slot open in another tab keeps its saved edits.
  clear.addEventListener("click", async () => {
    destroy();
    if (documentId !== undefined) await clearWriterStores({ database: DATABASE, documentId, labels: LABELS, slots: SLOTS });
    location.reload();
  });
  try {
    documentId = await readDocumentId(url);
    for (const label of LABELS) {
      const name = "Writer " + label;
      const store = await openWriterStore({ database: DATABASE, documentId, label, slots: SLOTS });
      if (store === undefined) {
        const pane = element("section", "writer");
        pane.append(element("h2", undefined, name), element("p", "message", `${name} is open in ${SLOTS} other tabs.`));
        writers.append(pane);
        continue;
      }
      const network = createOfflineSwitch();
      /** @type {TreeSync} */
      let sync;
      try {
        sync = await connectSync(Tree, { pollInterval: 1000, store, presence: { schema: selectionSchema },
          transport: createHttpTransport({ url: new URL("/sync/", url), fetch: network.fetch }) });
      } catch (error) {
        store.close();
        throw error;
      }
      if (destroyed) { sync.close(); break; }
      names.set(sync.doc.checkpoint().clientId, name);
      stops.push(mountWriter(writers, name, sync, network, names, sync.doc.checkpoint().pendingBatches.length));
    }
    if (!destroyed) status.textContent = "Ready.";
  } catch (error) {
    status.textContent = "Stopped: " + describeError(error);
    status.dataset.state = "error";
    destroy();
  }
  return { destroy };
}

/**
 * One writer's tree. The tree is rebuilt after every change; folders it has collapsed stay collapsed.
 * @param {HTMLElement} parent @param {string} name @param {TreeSync} sync
 * @param {ReturnType<typeof createOfflineSwitch>} network
 * @param {ReadonlyMap<string, string>} names Writer names by client ID.
 * @param {number} restored Pending batches restored from the store, for a notice.
 * @returns {() => void} Stops the writer and removes its listeners.
 */
function mountWriter(parent, name, sync, network, names, restored) {
  const doc = sync.doc;
  const section = element("section", "writer");
  section.setAttribute("aria-label", name);
  const heading = element("h2", undefined, name + " ");
  const badge = element("span", "badge");
  heading.append(badge);
  const tree = element("ul", "tree");
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", name + " files");
  const nameInput = element("input");
  nameInput.placeholder = "Name";
  nameInput.maxLength = 100;
  nameInput.setAttribute("aria-label", `Name (${name})`);
  const newFolder = button("New folder"), newFile = button("New file"), rename = button("Rename"), remove = button("Delete");
  const target = element("select");
  target.setAttribute("aria-label", `Move to (${name})`);
  const move = button("Move");
  const edit = element("div", "toolbar");
  edit.append(nameInput, newFolder, newFile, rename, remove, target, move);
  const undoButton = button("Undo"), redoButton = button("Redo"), discard = button("Discard blocked edits");
  undoButton.setAttribute("aria-keyshortcuts", "Control+Z Meta+Z");
  redoButton.setAttribute("aria-keyshortcuts", "Control+Shift+Z Meta+Shift+Z Control+Y");
  discard.hidden = true;
  const offlineLabel = element("label");
  const offline = element("input");
  offline.type = "checkbox";
  offlineLabel.append(offline, " Offline");
  const controls = element("div", "toolbar");
  controls.append(undoButton, redoButton, offlineLabel, discard);
  const message = element("p", "message");
  message.setAttribute("aria-live", "polite");
  const notices = element("ul", "notices");
  notices.setAttribute("aria-live", "polite");
  section.append(heading, edit, tree, controls, message, notices);
  parent.append(section);

  // This writer's own edits only: undo never reverts what the other writer changed since.
  const history = createUndoManager(doc);
  /** @type {string | undefined} */
  let selected;
  /** Folders this writer collapsed; new folders start open. */
  const collapsed = new Set();
  let stopped = false, scheduled = false, cancelling = false;
  /** @type {string | undefined} */
  let dragging;

  /** @param {string} text */
  function notify(text) {
    const item = element("li", undefined, text + " ");
    const dismiss = button("Dismiss");
    dismiss.addEventListener("click", () => item.remove());
    item.append(dismiss);
    notices.append(item);
  }
  /** @param {string | undefined} id */
  function select(id) {
    if (selected === id) return;
    selected = id;
    nameInput.value = id === undefined ? "" : doc.state.names.get(id) ?? "";
    sync.presence.set({ selected: id ?? null });
    schedule();
  }
  /** @param {() => void} action */
  function act(action) {
    try { action(); }
    catch (error) { message.textContent = "Not applied: " + describeError(error); }
    schedule();
  }
  /** Where new nodes go: the selected folder, the selected file's folder, or the top level. */
  function folderForNew() {
    if (selected === undefined) return ROOT;
    return isFolder(doc, selected) ? selected : doc.state.parents.get(selected) ?? ROOT;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(render);
  }
  function render() {
    scheduled = false;
    if (stopped) return;
    if (selected !== undefined && !doc.state.parents.has(selected)) select(undefined);
    /** Writer names by the node they selected. @type {Map<string, string[]>} */
    const peers = new Map();
    for (const [clientId, { selected: id }] of sync.presence.peers) {
      if (id !== null) peers.set(id, [...peers.get(id) ?? [], names.get(clientId) ?? clientId]);
    }
    const hadFocus = tree.contains(document.activeElement);
    tree.replaceChildren(...childrenOf(doc, ROOT).map((id) => renderNode(id, peers)));
    const row = tree.querySelector('[aria-selected="true"] .row');
    if (hadFocus && row instanceof HTMLElement) row.focus();
    /** @type {[string, string][]} */
    const options = [[ROOT, "/ (top level)"], ...folders().map((id) => /** @type {[string, string]} */ ([id, "/" + (pathOf(doc, id) ?? "")]))];
    target.replaceChildren(...options.map(([value, label]) => {
      const option = element("option", undefined, label);
      option.value = value;
      // Not into the node itself or below it.
      option.disabled = selected !== undefined && isWithin((node) => doc.state.parents.get(node), value, selected);
      return option;
    }));
    for (const control of [rename, remove, target, move]) control.disabled = selected === undefined || tree.inert;
  }
  /** Every folder, for the move list. */
  function folders() {
    return [...doc.state.kinds].filter(([, kind]) => kind === "folder").map(([id]) => id)
      .filter((id) => doc.state.parents.has(id)).toSorted((a, b) => (pathOf(doc, a) ?? "").localeCompare(pathOf(doc, b) ?? ""));
  }
  /** @param {string} id @param {ReadonlyMap<string, string[]>} peers */
  function renderNode(id, peers) {
    const folder = isFolder(doc, id), open = folder && !collapsed.has(id);
    const item = element("li");
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-selected", String(id === selected));
    if (folder) item.setAttribute("aria-expanded", String(open));
    item.dataset.id = id;
    const row = element("span", "row");
    row.tabIndex = id === selected ? 0 : -1;
    row.draggable = true;
    const toggle = element("span", "toggle", folder ? (open ? "▾" : "▸") : "");
    row.append(toggle, element("span", "icon", folder ? "📁" : "📄"), element("span", "name", doc.state.names.get(id) ?? ""));
    for (const writer of peers.get(id) ?? []) row.append(element("span", "peer", writer));
    item.append(row);
    if (open) {
      const group = element("ul");
      group.setAttribute("role", "group");
      group.append(...childrenOf(doc, id).map((child) => renderNode(child, peers)));
      item.append(group);
    }
    return item;
  }

  /** @param {Event} event */
  function onClick(event) {
    const id = nodeOf(event);
    if (id === undefined) { select(undefined); return; }
    if (event.target instanceof Element && event.target.closest(".toggle") !== null) {
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    }
    select(id);
    schedule();
  }
  /** @param {"folder" | "file"} kind */
  function onNew(kind) {
    act(() => {
      const id = createNode(doc, folderForNew(), kind, nameInput.value || (kind === "folder" ? "New folder" : "untitled.txt"));
      select(id);
    });
  }
  /** @param {string} id @param {string} folder */
  function moveTo(id, folder) {
    act(() => { if (!moveNode(doc, id, folder)) message.textContent = "Cannot move it there."; });
  }
  /** @param {Event} event */
  function onDragStart(event) {
    dragging = nodeOf(event);
    if (dragging !== undefined && event instanceof DragEvent) event.dataTransfer?.setData("text/plain", dragging);
  }
  /** A file drops into its folder; empty space drops at the top level. @param {Event} event */
  function dropFolder(event) {
    const id = nodeOf(event);
    if (id === undefined) return ROOT;
    return isFolder(doc, id) ? id : doc.state.parents.get(id) ?? ROOT;
  }
  /** @param {Event} event */
  function onDragOver(event) {
    if (dragging !== undefined) event.preventDefault();
  }
  /** @param {Event} event */
  function onDrop(event) {
    if (dragging === undefined) return;
    event.preventDefault();
    const id = dragging;
    dragging = undefined;
    moveTo(id, dropFolder(event));
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let refreshing;
  // At most every 250 ms: checkpoint() copies the document.
  function refresh() {
    const shown = describeSync(sync.status, sync.push, network.offline);
    badge.textContent = shown.text;
    badge.dataset.state = shown.state;
    discard.hidden = sync.status !== "blocked";
    const disabled = ["blocked", "gap", "failed", "closed"].includes(sync.status);
    tree.inert = disabled;
    for (const control of [nameInput, newFolder, newFile]) control.disabled = disabled;
    undoButton.disabled = disabled || !history.canUndo;
    redoButton.disabled = disabled || !history.canRedo;
    schedule();
    if (sync.status === "failed") {
      message.textContent = "Sync failed: " + describeError(sync.error) + ". Inspect and preserve the checkpoint.";
      return;
    }
    refreshing ??= setTimeout(() => {
      refreshing = undefined;
      const pending = doc.checkpoint().pendingBatches.length;
      message.textContent = pending === 0 ? "All edits are saved on the server."
        : `${pending} ${pending === 1 ? "edit is" : "edits are"} waiting to be sent.`;
    }, 250);
  }

  // Whatever the server changed in this writer's batches, including undo and restored ones.
  const stopTransform = doc.on("transform", (event) => {
    if (!cancelling) for (const notice of describeTransform(event, doc)) notify(notice);
  });
  const stopChange = doc.on("change", refresh);
  const stopPeers = sync.presence.on("change", schedule);
  const stopStatus = sync.on("status", refresh), stopPush = sync.on("push", refresh);
  const stopHistory = history.on("change", refresh);
  const onUndo = () => { act(() => { history.undo(); }); };
  const onRedo = () => { act(() => { history.redo(); }); };
  /** Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z or Ctrl+Y redoes, except in the name field, which keeps its own undo. */
  const onKeyDown = (/** @type {Event} */ event) => {
    if (!(event instanceof KeyboardEvent) || !(event.ctrlKey || event.metaKey) || event.altKey || event.target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    const redo = (key === "z" && event.shiftKey) || (key === "y" && event.ctrlKey && !event.shiftKey);
    if (key !== "z" && !redo) return;
    event.preventDefault();
    if (tree.inert) return;
    if (redo) onRedo(); else onUndo();
  };
  const onOffline = () => {
    network.set(offline.checked);
    refresh();
    if (!offline.checked) sync.sync().catch(() => {}); // Like the browser's online event.
  };
  // Edits this writer cancels itself are not news.
  const onDiscard = () => {
    cancelling = true;
    sync.rejectPending().catch(() => {}).finally(() => { cancelling = false; refresh(); });
  };
  const onNewFolder = () => onNew("folder"), onNewFile = () => onNew("file");
  const onRename = () => { act(() => { if (selected !== undefined) renameNode(doc, selected, nameInput.value); }); };
  const onRemove = () => { act(() => { if (selected !== undefined) deleteNode(doc, selected); }); };
  const onMove = () => { if (selected !== undefined) moveTo(selected, target.value); };
  /** @type {[EventTarget, string, (event: Event) => void][]} */
  const listeners = [
    [tree, "click", onClick], [tree, "dragstart", onDragStart], [tree, "dragover", onDragOver], [tree, "drop", onDrop],
    [newFolder, "click", onNewFolder], [newFile, "click", onNewFile], [rename, "click", onRename], [remove, "click", onRemove],
    [move, "click", onMove], [undoButton, "click", onUndo], [redoButton, "click", onRedo], [section, "keydown", onKeyDown],
    [offline, "change", onOffline], [discard, "click", onDiscard],
  ];
  for (const [node, type, listener] of listeners) node.addEventListener(type, listener);
  refresh();
  if (restored > 0) notify(`Restored ${restored} unsent ${restored === 1 ? "edit" : "edits"} from before a reload or from a closed tab.`);

  return () => {
    stopped = true;
    sync.close();
    stopTransform(); stopChange(); stopPeers(); stopStatus(); stopPush(); stopHistory(); history.destroy();
    clearTimeout(refreshing);
    for (const [node, type, listener] of listeners) node.removeEventListener(type, listener);
  };
}
