// @ts-check
import { CheckpointLockedError, connectSync, createHttpTransport, openIndexedDbStore } from "../../dist/sync/index.js";
import { createOfflineSwitch, describeSync } from "../sync-ui.js";
import {
  addCard, Board, cardFor, cardsIn, COLUMNS, createSelection, deleteCard, findCard, lostRenames, moveCard, renameCard,
} from "./board.js";

/** @typedef {import("./board.js").Card} Card */
/** @typedef {import("./board.js").Column} Column */
/** @typedef {import("../../dist/sync/index.js").SyncClient<import("./board.js").Shape>} BoardSync */

const COLUMN_NAMES = { todo: "To do", doing: "Doing", done: "Done" };
const ACTIONS = /** @type {const} */ ([
  ["left", "←", "Move to the previous column"], ["up", "↑", "Move up"], ["down", "↓", "Move down"],
  ["right", "→", "Move to the next column"], ["delete", "✕", "Delete"],
]);

/** @param {unknown} error */
function describeError(error) { return error instanceof Error ? error.message : String(error); }

/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [className] @param {string} [text] */
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {Card} card */
function renderCard(card) {
  const item = element("li", "card");
  item.draggable = true;
  const actions = element("span", "actions");
  for (const [action, symbol] of ACTIONS) {
    const button = element("button", undefined, symbol);
    button.type = "button";
    button.dataset.action = action;
    actions.append(button);
  }
  item.append(element("span", "title"), actions);
  updateCard(item, card);
  return item;
}

/** Updates a card in place, so a focused button survives. An acknowledgement that adopts a decoded
 * copy of this writer's own card is reported as a set; an equal card changes nothing.
 * @param {Element} item @param {Card} card */
function updateCard(item, card) {
  if (!(item instanceof HTMLLIElement) || (item.dataset.cardId === card.id && item.dataset.title === card.title)) return;
  item.dataset.cardId = card.id;
  item.dataset.title = card.title;
  const title = item.querySelector(".title");
  if (title !== null) title.textContent = card.title;
  for (const button of item.querySelectorAll("button[data-action]")) {
    const label = ACTIONS.find(([action]) => action === button.getAttribute("data-action"))?.[2];
    button.setAttribute("aria-label", `${label}: ${card.title}`);
  }
}

/** The drop gap: before the first card whose middle is below the pointer.
 * @param {HTMLOListElement} list @param {number} y */
function dropIndex(list, y) {
  const items = [...list.children];
  const index = items.findIndex((item) => { const box = item.getBoundingClientRect(); return y < box.top + box.height / 2; });
  return index === -1 ? items.length : index;
}

/** IndexedDB database for both writers' checkpoints; each writer has its own key. */
const DATABASE = "articollab-kanban";
const LABELS = ["A", "B"];

/** The server's document identity. Stored checkpoints are keyed by it, so a restarted server starts fresh.
 * @param {string} url */
async function readDocumentId(url) {
  const response = await fetch(new URL("/document", url));
  /** @type {unknown} */
  const body = response.ok ? await response.json() : undefined;
  if (typeof body !== "object" || body === null || !("documentId" in body) || typeof body.documentId !== "string") {
    throw new Error("The server did not report a document ID");
  }
  return body.documentId;
}

/** @param {string} documentId @param {string} label */
function storeKey(documentId, label) {
  return `${documentId}:${label}`;
}

/** Explicit mount keeps imports free of DOM, requests and writer registration.
 * @param {HTMLElement} root @param {string} url */
export async function mountKanban(root, url) {
  const status = element("p", undefined, "Opening two writer sessions…");
  status.setAttribute("role", "status");
  const clear = element("button", undefined, "Clear saved edits and reload");
  clear.type = "button";
  const writers = element("div", "writers");
  root.append(status, clear, writers);
  /** @type {(() => void)[]} */
  const stops = [];
  let destroyed = false;
  /** @type {string | undefined} */
  let documentId;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const stop of stops) stop();
  }
  // Stopping the writers releases their locks; a writer open in another tab keeps its saved edits.
  clear.addEventListener("click", async () => {
    destroy();
    if (documentId !== undefined) {
      for (const label of LABELS) {
        try {
          const store = await openIndexedDbStore({ database: DATABASE, key: storeKey(documentId, label) });
          try { await store.clear(); } finally { store.close(); }
        } catch (error) {
          if (!(error instanceof CheckpointLockedError)) throw error;
        }
      }
    }
    location.reload();
  });
  try {
    documentId = await readDocumentId(url);
    let locked = 0;
    for (const label of LABELS) {
      const name = "Writer " + label;
      let store;
      try {
        store = await openIndexedDbStore({ database: DATABASE, key: storeKey(documentId, label) });
      } catch (error) {
        if (!(error instanceof CheckpointLockedError)) throw error;
        // Another tab already runs this writer; a second copy would reuse its client ID.
        const pane = element("section", "writer");
        pane.append(element("h2", undefined, name), element("p", "message", `${name} is open in another tab.`));
        writers.append(pane);
        locked++;
        continue;
      }
      const network = createOfflineSwitch();
      let sync;
      try {
        sync = await connectSync(Board, { pollInterval: 1000, store,
          transport: createHttpTransport({ url: new URL("/sync/", url), fetch: network.fetch }) });
      } catch (error) {
        store.close();
        throw error;
      }
      if (destroyed) { sync.stop(); break; }
      stops.push(mountWriter(writers, name, sync, network, sync.doc.checkpoint().pendingBatches.length));
    }
    if (!destroyed) {
      status.textContent = locked === LABELS.length ? "Both writers are open in another tab."
        : "Ready. Drag cards or use their buttons; both writers update automatically. Unsent edits survive a reload.";
    }
  } catch (error) {
    status.textContent = "Stopped: " + describeError(error);
    status.dataset.state = "error";
    destroy();
  }
  return { destroy };
}

/**
 * One writer's board. Observers of `order` and `columns` schedule one render per microtask, which
 * places each card's row in its column and reuses rows, so a moved card keeps its row; titles update
 * in place. The selection is re-read after each render.
 * @param {HTMLElement} parent @param {string} name @param {BoardSync} sync
 * @param {ReturnType<typeof createOfflineSwitch>} network
 * @param {number} [restored] Pending batches restored from the store, for a notice.
 * @returns {() => void} Stops the writer and removes its listeners.
 */
function mountWriter(parent, name, sync, network, restored = 0) {
  const doc = sync.doc;
  const section = element("section", "writer");
  section.setAttribute("aria-label", name);
  const heading = element("h2", undefined, name + " ");
  const badge = element("span", "badge");
  heading.append(badge);
  const identity = element("p", "identity", doc.checkpoint().clientId);
  const board = element("fieldset", "board");
  const legend = element("legend", "visually-hidden", name + " board");
  const columns = element("div", "columns");
  board.append(legend, columns);

  /** @type {Map<Column, HTMLOListElement>} */
  const lists = new Map();
  /** @type {(() => void)[]} */
  const cleanups = [];
  for (const column of COLUMNS) {
    const container = element("section", "column");
    container.dataset.column = column;
    const title = element("h3", undefined, COLUMN_NAMES[column]);
    const form = element("form", "add");
    const input = element("input");
    input.required = true; input.maxLength = 200; input.placeholder = "New card";
    input.setAttribute("aria-label", `New card in ${COLUMN_NAMES[column]} (${name})`);
    const add = element("button", undefined, "Add");
    form.append(input, add);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      act(() => { const card = addCard(doc, column, input.value); input.value = ""; selection.select(card.id); });
    });
    const list = element("ol", "cards");
    list.dataset.column = column;
    lists.set(column, list);
    container.append(title, form, list);
    columns.append(container);
  }

  /** Places each card's row in its column in board order, reusing existing rows. */
  function renderColumns() {
    /** @type {Map<string, HTMLLIElement>} */
    const rows = new Map();
    for (const item of columns.querySelectorAll("li.card")) {
      if (item instanceof HTMLLIElement && item.dataset.cardId !== undefined) rows.set(item.dataset.cardId, item);
    }
    for (const column of COLUMNS) {
      const list = lists.get(column);
      if (list === undefined) continue;
      const ids = cardsIn(doc, column);
      ids.forEach((id, index) => {
        const existing = rows.get(id);
        rows.delete(id);
        const item = existing ?? renderCard(cardFor(doc, id));
        if (existing !== undefined) updateCard(item, cardFor(doc, id));
        if (list.children[index] !== item) list.insertBefore(item, list.children[index] ?? null);
      });
      // Rows past the column's cards belong to another column, which re-attaches them, or were deleted.
      while (list.children.length > ids.length) list.lastElementChild?.remove();
    }
  }

  const editor = element("form", "rename");
  editor.hidden = true;
  const editorLabel = element("label", undefined, "Selected card ");
  const titleInput = element("input");
  titleInput.required = true; titleInput.maxLength = 200;
  editorLabel.append(titleInput);
  const save = element("button", undefined, "Rename");
  editor.append(editorLabel, save);
  board.append(editor);

  const controls = element("div", "controls");
  const offlineLabel = element("label");
  const offline = element("input");
  offline.type = "checkbox";
  offlineLabel.append(offline, " Offline");
  const discard = element("button", undefined, "Discard blocked edits");
  discard.type = "button"; discard.hidden = true;
  controls.append(offlineLabel, discard);
  const message = element("p", "message");
  message.setAttribute("aria-live", "polite");
  const notices = element("ul", "notices");
  notices.setAttribute("aria-live", "polite");
  section.append(heading, identity, board, controls, message, notices);
  parent.append(section);

  const selection = createSelection(doc);
  let stopped = false, scheduled = false;
  /** Restores keyboard focus to a card's button after its row was re-created by a move. */
  /** @type {{cardId: string, action: string} | undefined} */
  let refocus;
  let editing = /** @type {string | undefined} */ (undefined);

  /** @param {() => void} action */
  function act(action) {
    try { action(); }
    catch (error) { message.textContent = "Not applied: " + describeError(error); }
    schedule();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(refreshSelection);
  }
  function refreshSelection() {
    scheduled = false;
    if (stopped) return;
    renderColumns();
    const current = selection.resolve();
    for (const item of columns.querySelectorAll("li.card")) {
      if (!(item instanceof HTMLLIElement)) continue;
      if (item.dataset.cardId === current?.card.id) item.setAttribute("aria-current", "true");
      else item.removeAttribute("aria-current");
    }
    editor.hidden = current === undefined;
    if (current !== undefined && (editing !== current.card.id || document.activeElement !== titleInput)) {
      titleInput.value = current.card.title;
    }
    editing = current?.card.id;
    if (refocus !== undefined) {
      const item = columns.querySelector(`li[data-card-id="${CSS.escape(refocus.cardId)}"]`);
      const button = item?.querySelector(`button[data-action="${refocus.action}"]`);
      if (button instanceof HTMLButtonElement) button.focus();
      refocus = undefined;
    }
  }

  /** @param {string} action @param {string} cardId */
  function runAction(action, cardId) {
    act(() => {
      const found = findCard(doc, cardId);
      if (found === undefined) return;
      const position = COLUMNS.indexOf(found.column);
      const length = cardsIn(doc, found.column).length;
      if (action === "delete") { selection.select(cardId); deleteCard(doc, cardId); return; }
      if (action === "up" && found.index > 0) moveCard(doc, cardId, found.column, found.index - 1);
      if (action === "down" && found.index < length - 1) moveCard(doc, cardId, found.column, found.index + 2);
      const next = COLUMNS[position + (action === "left" ? -1 : action === "right" ? 1 : 0)];
      if (next !== undefined && next !== found.column) {
        moveCard(doc, cardId, next, Math.min(found.index, cardsIn(doc, next).length));
      }
      selection.select(cardId);
      refocus = { cardId, action };
    });
  }

  /** @param {Event} event */
  function onClick(event) {
    if (!(event.target instanceof Element)) return;
    const item = event.target.closest("li.card");
    if (!(item instanceof HTMLLIElement) || item.dataset.cardId === undefined) return;
    const button = event.target.closest("button[data-action]");
    if (button instanceof HTMLButtonElement && button.dataset.action !== undefined) runAction(button.dataset.action, item.dataset.cardId);
    else { selection.select(item.dataset.cardId); schedule(); }
  }
  /** @param {SubmitEvent} event */
  function onRename(event) {
    event.preventDefault();
    const cardId = selection.cardId;
    if (cardId === undefined) return;
    act(() => { if (!renameCard(doc, cardId, titleInput.value)) message.textContent = "That card no longer exists."; });
  }

  // Native drag and drop within this writer's board.
  /** @type {string | undefined} */
  let dragging;
  function clearDrop() {
    for (const marked of columns.querySelectorAll(".drop-before, .drop-end")) marked.classList.remove("drop-before", "drop-end");
  }
  /** @param {DragEvent} event */
  function onDragStart(event) {
    const item = event.target instanceof Element ? event.target.closest("li.card") : null;
    if (!(item instanceof HTMLLIElement) || item.dataset.cardId === undefined || board.disabled) { event.preventDefault(); return; }
    dragging = item.dataset.cardId;
    event.dataTransfer?.setData("text/plain", item.dataset.cardId);
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
    item.classList.add("dragging");
  }
  /** @param {DragEvent} event */
  function dropTarget(event) {
    const list = event.target instanceof Element ? event.target.closest("ol.cards") : null;
    return dragging !== undefined && list instanceof HTMLOListElement ? list : undefined;
  }
  /** @param {DragEvent} event */
  function onDragOver(event) {
    const list = dropTarget(event);
    if (list === undefined) return;
    event.preventDefault();
    clearDrop();
    const index = dropIndex(list, event.clientY);
    (list.children[index] ?? list).classList.add(index < list.children.length ? "drop-before" : "drop-end");
  }
  /** @param {DragEvent} event */
  function onDrop(event) {
    const list = dropTarget(event), cardId = dragging;
    const column = COLUMNS.find((candidate) => candidate === list?.dataset.column);
    if (list === undefined || cardId === undefined || column === undefined) return;
    event.preventDefault();
    const index = dropIndex(list, event.clientY);
    clearDrop();
    act(() => { moveCard(doc, cardId, column, index); selection.select(cardId); });
  }
  function onDragEnd() {
    dragging = undefined;
    clearDrop();
    for (const item of columns.querySelectorAll(".dragging")) item.classList.remove("dragging");
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let refreshing;
  // checkpoint() copies the document, so the pending count is refreshed at most every 250 ms.
  function refresh() {
    const shown = describeSync(sync.status, sync.push, network.offline);
    badge.textContent = shown.text;
    badge.dataset.state = shown.state;
    discard.hidden = sync.status !== "blocked";
    board.disabled = ["blocked", "gap", "failed", "stopped"].includes(sync.status);
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
  /** @param {string} text */
  function notify(text) {
    const item = element("li", undefined, text + " ");
    const dismiss = element("button", undefined, "Dismiss");
    dismiss.type = "button";
    dismiss.addEventListener("click", () => item.remove());
    item.append(dismiss);
    notices.append(item);
  }

  const clientId = doc.checkpoint().clientId;
  const stopChange = doc.on("change", (event) => {
    refresh(); schedule();
    // A peer deleted cards this writer is still renaming: the server will apply those renames after the
    // delete, and the policy drops them. Removing a card from its column is visible, so this event fires.
    if (event.origin !== "server" || event.commit.source.clientId === clientId ||
      !event.commit.operations.some((operation) => operation.type === "map/delete")) return;
    for (const card of lostRenames(event.commit, doc.checkpoint().pendingBatches)) {
      notify(`Not saved: “${card.title}”. Another writer deleted this card.`);
    }
  });
  // A move of a card a peer deleted first changed nothing; the server reports it on acknowledgement.
  const stopDiscard = doc.on("discard", ({ operations }) => {
    for (const operation of operations) {
      if (operation.type === "list/move") notify("Not moved: another writer deleted that card.");
    }
  });
  cleanups.push(doc.state.order.observe(schedule), doc.state.columns.observe(schedule));
  // Titles live in `titles`: update the card's row in place, wherever it is.
  cleanups.push(doc.state.titles.observe(({ changes }) => {
    for (const change of changes) {
      if (change.type !== "set") continue;
      const item = columns.querySelector(`li[data-card-id="${CSS.escape(change.key)}"]`);
      if (item !== null) updateCard(item, { id: change.key, title: change.value });
    }
  }));
  renderColumns();
  const stopStatus = sync.on("status", refresh), stopPush = sync.on("push", refresh);
  const onOffline = () => {
    network.set(offline.checked);
    refresh();
    if (!offline.checked) sync.sync().catch(() => {}); // Like the browser's online event.
  };
  const onDiscard = () => { sync.rejectPending().catch(() => {}).finally(refresh); };
  columns.addEventListener("click", onClick);
  columns.addEventListener("dragstart", onDragStart);
  columns.addEventListener("dragover", onDragOver);
  columns.addEventListener("drop", onDrop);
  columns.addEventListener("dragend", onDragEnd);
  editor.addEventListener("submit", onRename);
  offline.addEventListener("change", onOffline);
  discard.addEventListener("click", onDiscard);
  refresh();
  if (restored > 0) notify(`Restored ${restored} unsent ${restored === 1 ? "edit" : "edits"} from before the reload; they are sent once this writer is online.`);

  return () => {
    stopped = true;
    sync.stop();
    for (const cleanup of cleanups) cleanup();
    stopChange(); stopDiscard(); stopStatus(); stopPush();
    clearTimeout(refreshing);
    columns.removeEventListener("click", onClick);
    columns.removeEventListener("dragstart", onDragStart);
    columns.removeEventListener("dragover", onDragOver);
    columns.removeEventListener("drop", onDrop);
    columns.removeEventListener("dragend", onDragEnd);
    editor.removeEventListener("submit", onRename);
    offline.removeEventListener("change", onOffline);
    discard.removeEventListener("click", onDiscard);
  };
}
