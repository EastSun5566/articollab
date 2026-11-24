// @ts-check
import { createUndoManager } from "../../dist/index.js";
import { connectSync, createHttpTransport } from "../../dist/sync/index.js";
import { createOfflineSwitch, describeSync } from "../shared/sync-ui.js";
import { clearWriterStores, openWriterStore, readDocumentId } from "../shared/writer-store.js";
import {
  addCard, Board, cardFor, cardsIn, COLUMNS, createSelection, deleteCard, findCard, moveCard, renameCard, voteCard,
  watchDroppedEdits,
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

/** @param {Card} card @param {number} votes */
function renderCard(card, votes) {
  const item = element("li", "card");
  item.draggable = true;
  const actions = element("span", "actions");
  const vote = element("button", "vote");
  vote.type = "button";
  vote.dataset.action = "vote";
  for (const [action, symbol] of ACTIONS) {
    const button = element("button", undefined, symbol);
    button.type = "button";
    button.dataset.action = action;
    actions.append(button);
  }
  const head = element("span", "head");
  head.append(element("span", "title"), vote);
  item.append(head, actions);
  updateCard(item, card);
  updateVotes(item, votes);
  return item;
}

/** Shows a card's vote count. @param {Element} item @param {number} votes */
function updateVotes(item, votes) {
  const button = item.querySelector("button.vote");
  if (!(item instanceof HTMLLIElement) || !(button instanceof HTMLButtonElement)) return;
  item.dataset.votes = String(votes);
  button.textContent = `👍 ${votes}`;
  button.setAttribute("aria-label", `Vote for ${item.getAttribute("data-title") ?? "this card"}: ${votes} ${votes === 1 ? "vote" : "votes"}`);
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
    if (label !== undefined) button.setAttribute("aria-label", `${label}: ${card.title}`);
  }
  // The vote button's label names the title too.
  updateVotes(item, Number(item.dataset.votes ?? 0));
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
/** Tabs that can run each writer at once; every tab is its own writer in a free slot. */
const SLOTS = 4;

/** Mounts two writers into `root`, synced with the host at `url`.
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
  // Stopping the writers releases their locks; a slot open in another tab keeps its saved edits.
  clear.addEventListener("click", async () => {
    destroy();
    if (documentId !== undefined) await clearWriterStores({ database: DATABASE, documentId, labels: LABELS, slots: SLOTS });
    location.reload();
  });
  try {
    documentId = await readDocumentId(url);
    let locked = 0;
    for (const label of LABELS) {
      const name = "Writer " + label;
      const store = await openWriterStore({ database: DATABASE, documentId, label, slots: SLOTS });
      if (store === undefined) {
        // Every slot is held by another tab; a second copy of a slot would reuse its client ID.
        const pane = element("section", "writer");
        pane.append(element("h2", undefined, name), element("p", "message", `${name} is open in ${SLOTS} other tabs.`));
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
      if (destroyed) { sync.close(); break; }
      stops.push(mountWriter(writers, name, sync, network, store.slot, sync.doc.checkpoint().pendingBatches.length));
    }
    if (!destroyed) {
      status.textContent = locked === LABELS.length ? `Both writers are open in ${SLOTS} other tabs.`
        : "Ready.";
    }
  } catch (error) {
    status.textContent = "Stopped: " + describeError(error);
    status.dataset.state = "error";
    destroy();
  }
  return { destroy };
}

/**
 * One writer's board. Rows are reused across renders, so a moved card keeps its row and focus.
 * @param {HTMLElement} parent @param {string} name @param {BoardSync} sync
 * @param {ReturnType<typeof createOfflineSwitch>} network
 * @param {number} slot The store slot this tab took for the writer.
 * @param {number} [restored] Pending batches restored from the store, for a notice.
 * @returns {() => void} Stops the writer and removes its listeners.
 */
function mountWriter(parent, name, sync, network, slot, restored = 0) {
  const doc = sync.doc;
  const section = element("section", "writer");
  section.setAttribute("aria-label", name);
  const heading = element("h2", undefined, name + " ");
  const badge = element("span", "badge");
  heading.append(badge);
  const identity = element("p", "identity", `${doc.checkpoint().clientId} · tab slot ${slot + 1} of ${SLOTS}`);
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
        const item = existing ?? renderCard(cardFor(doc, id), doc.state.votes.get(id));
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
  const undoButton = element("button", undefined, "Undo");
  const redoButton = element("button", undefined, "Redo");
  undoButton.type = "button"; redoButton.type = "button";
  undoButton.setAttribute("aria-keyshortcuts", "Control+Z Meta+Z");
  redoButton.setAttribute("aria-keyshortcuts", "Control+Shift+Z Meta+Shift+Z Control+Y");
  const discard = element("button", undefined, "Discard blocked edits");
  discard.type = "button"; discard.hidden = true;
  controls.append(undoButton, redoButton, offlineLabel, discard);
  const message = element("p", "message");
  message.setAttribute("aria-live", "polite");
  const notices = element("ul", "notices");
  notices.setAttribute("aria-live", "polite");
  section.append(heading, identity, board, controls, message, notices);
  parent.append(section);

  const selection = createSelection(doc);
  // This writer's own edits only: undo never reverts what the other writer changed since.
  const history = createUndoManager(doc);
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
      if (action === "vote") {
        // Tracked, so a vote the server drops because the card was deleted is reported.
        const { value: voted, settled } = doc.track(() => voteCard(doc, cardId));
        if (voted) dropped.follow(settled);
        refocus = { cardId, action };
        return;
      }
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
    act(() => {
      // Tracked, so a rename the server drops is reported for this very edit.
      const { value: renamed, settled } = doc.track(() => renameCard(doc, cardId, titleInput.value));
      if (renamed) dropped.follow(settled); else message.textContent = "That card no longer exists.";
    });
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
  // At most every 250 ms: checkpoint() copies the document.
  function refresh() {
    const shown = describeSync(sync.status, sync.push, network.offline);
    badge.textContent = shown.text;
    badge.dataset.state = shown.state;
    discard.hidden = sync.status !== "blocked";
    board.disabled = ["blocked", "gap", "failed", "closed"].includes(sync.status);
    undoButton.disabled = board.disabled || !history.canUndo;
    redoButton.disabled = board.disabled || !history.canRedo;
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

  const stopChange = doc.on("change", () => { refresh(); schedule(); });
  // The server dropped this writer's rename or move of a card a peer deleted first.
  const dropped = watchDroppedEdits(doc, notify);
  // Renames restored from before a reload are followed too, by their pending batches.
  for (const batch of doc.checkpoint().pendingBatches) dropped.follow(doc.settled(batch));
  cleanups.push(doc.state.order.observe(schedule), doc.state.columns.observe(schedule));
  // Titles live in `titles`: update the card's row in place, wherever it is.
  cleanups.push(doc.state.titles.observe(({ changes }) => {
    for (const change of changes) {
      if (change.type !== "set") continue;
      const item = columns.querySelector(`li[data-card-id="${CSS.escape(change.key)}"]`);
      if (item !== null) updateCard(item, { id: change.key, title: change.value });
    }
  }));
  // Votes live in `votes`: update the count in place; a concurrent vote adds to it rather than replacing it.
  cleanups.push(doc.state.votes.observe(({ changes }) => {
    for (const change of changes) {
      const item = columns.querySelector(`li[data-card-id="${CSS.escape(change.key)}"]`);
      if (item !== null) updateVotes(item, change.value);
    }
  }));
  renderColumns();
  const stopStatus = sync.on("status", refresh), stopPush = sync.on("push", refresh);
  const onUndo = () => { act(() => { history.undo(); }); };
  const onRedo = () => { act(() => { history.redo(); }); };
  /** Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z or Ctrl+Y redoes, except in text fields, which keep their own undo. */
  const onKeyDown = (/** @type {KeyboardEvent} */ event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    const redo = (key === "z" && event.shiftKey) || (key === "y" && event.ctrlKey && !event.shiftKey);
    if (key !== "z" && !redo) return;
    event.preventDefault();
    if (board.disabled) return;
    if (redo) onRedo(); else onUndo();
  };
  const stopHistory = history.on("change", refresh);
  const onOffline = () => {
    network.set(offline.checked);
    refresh();
    if (!offline.checked) sync.sync().catch(() => {}); // Like the browser's online event.
  };
  // Edits this writer cancels itself are not news.
  const onDiscard = () => { dropped.cancel(() => sync.rejectPending()).catch(() => {}).finally(refresh); };
  columns.addEventListener("click", onClick);
  undoButton.addEventListener("click", onUndo);
  redoButton.addEventListener("click", onRedo);
  section.addEventListener("keydown", onKeyDown);
  columns.addEventListener("dragstart", onDragStart);
  columns.addEventListener("dragover", onDragOver);
  columns.addEventListener("drop", onDrop);
  columns.addEventListener("dragend", onDragEnd);
  editor.addEventListener("submit", onRename);
  offline.addEventListener("change", onOffline);
  discard.addEventListener("click", onDiscard);
  refresh();
  if (restored > 0) notify(`Restored ${restored} unsent ${restored === 1 ? "edit" : "edits"} from before a reload or from a closed tab; they are sent once this writer is online.`);

  return () => {
    stopped = true;
    sync.close();
    for (const cleanup of cleanups) cleanup();
    stopChange(); dropped.stop(); stopHistory(); history.destroy(); stopStatus(); stopPush();
    clearTimeout(refreshing);
    columns.removeEventListener("click", onClick);
    undoButton.removeEventListener("click", onUndo);
    redoButton.removeEventListener("click", onRedo);
    section.removeEventListener("keydown", onKeyDown);
    columns.removeEventListener("dragstart", onDragStart);
    columns.removeEventListener("dragover", onDragOver);
    columns.removeEventListener("drop", onDrop);
    columns.removeEventListener("dragend", onDragEnd);
    editor.removeEventListener("submit", onRename);
    offline.removeEventListener("change", onOffline);
    discard.removeEventListener("click", onDiscard);
  };
}
