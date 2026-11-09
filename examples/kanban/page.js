// @ts-check
import { connectSync, createHttpTransport } from "../../dist/sync/index.js";
import { createOfflineSwitch, describeSync } from "../sync-ui.js";
import { addCard, Board, COLUMNS, createSelection, deleteCard, findCard, moveCard, renameCard } from "./board.js";
import { observeColumn } from "./view.js";

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

/** Explicit mount keeps imports free of DOM, requests and writer registration.
 * @param {HTMLElement} root @param {string} url */
export async function mountKanban(root, url) {
  const status = element("p", undefined, "Opening two writer sessions…");
  status.setAttribute("role", "status");
  const writers = element("div", "writers");
  root.append(status, writers);
  /** @type {(() => void)[]} */
  const stops = [];
  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const stop of stops) stop();
  }
  try {
    for (const label of ["A", "B"]) {
      const network = createOfflineSwitch();
      const sync = await connectSync(Board, { pollInterval: 1000,
        transport: createHttpTransport({ url: new URL("/sync/", url), fetch: network.fetch }) });
      if (destroyed) { sync.stop(); break; }
      stops.push(mountWriter(writers, "Writer " + label, sync, network));
    }
    if (!destroyed) status.textContent = "Ready. Drag cards or use their buttons; both writers update automatically.";
  } catch (error) {
    status.textContent = "Stopped: " + describeError(error);
    status.dataset.state = "error";
    destroy();
  }
  return { destroy };
}

/**
 * One writer's board. Columns render through `observeColumn`; the selection is re-read after every
 * change, once the observers have updated the DOM.
 * @param {HTMLElement} parent @param {string} name @param {BoardSync} sync
 * @param {ReturnType<typeof createOfflineSwitch>} network
 * @returns {() => void} Stops the writer and removes its listeners.
 */
function mountWriter(parent, name, sync, network) {
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
    cleanups.push(observeColumn(doc.state[column], {
      insert(index, card) { list.insertBefore(renderCard(card), list.children[index] ?? null); },
      remove(index) { list.children[index]?.remove(); },
      update(index, card) { const item = list.children[index]; if (item !== undefined) updateCard(item, card); },
    }));
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
      const length = doc.state[found.column].length;
      if (action === "delete") { selection.select(cardId); deleteCard(doc, cardId); return; }
      if (action === "up" && found.index > 0) moveCard(doc, cardId, found.column, found.index - 1);
      if (action === "down" && found.index < length - 1) moveCard(doc, cardId, found.column, found.index + 2);
      const next = COLUMNS[position + (action === "left" ? -1 : action === "right" ? 1 : 0)];
      if (next !== undefined && next !== found.column) {
        moveCard(doc, cardId, next, Math.min(found.index, doc.state[next].length));
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

  const stopChange = doc.on("change", () => { refresh(); schedule(); });
  // A rename that reached the server after another writer deleted the card changed nothing.
  const stopDiscard = doc.on("discard", ({ operations }) => {
    for (const operation of operations) notify(`Not saved: “${operation.value.title}”. Another writer deleted this card.`);
  });
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
