// @ts-check
import { createElement as h, useState } from "react";
import { useCollection, useDocument, usePeers, useSyncStatus, useUndoState } from "../../dist/react.js";
import { describeSync } from "../shared/sync-ui.js";

/** @typedef {import("./schema.js").Shape} Shape */
/** @typedef {import("./schema.js").Todo} Todo */
/** @typedef {import("./schema.js").Editing} Editing */
/** @typedef {import("../../dist/sync/index.js").PresenceSyncClient<Shape, Editing>} Sync */

/**
 * One writer: a sync client with presence, its undo manager, and a network switch to go offline.
 * @typedef {{ readonly label: string, readonly sync: Sync, readonly history: import("../../dist/index.js").UndoManager,
 *   readonly network: { readonly offline: boolean, set(offline: boolean): void } }} Writer
 */

/** Where the item is now: other writers may have moved it since this render. @param {Sync} sync @param {string} id */
function indexOf(sync, id) {
  return sync.doc.state.items.toArray().findIndex((item) => item.id === id);
}

/** Runs an edit, reporting what went wrong instead of breaking the page. @param {(message: string) => void} report @param {() => void} edit */
function attempt(report, edit) {
  try { edit(); report(""); }
  catch (error) { report("Not changed: " + (error instanceof Error ? error.message : String(error))); }
}

/**
 * A button's edit is its own undo step, even right after another one. Typing still merges into one
 * step while the keys come faster than the undo manager's captureTimeout.
 * @param {import("../../dist/index.js").UndoManager} history @param {(message: string) => void} report @param {() => void} edit
 */
function action(history, report, edit) {
  history.stopCapturing();
  attempt(report, edit);
  history.stopCapturing();
}

/** One item: a checkbox, its title and who else is editing it.
 * @param {{ sync: Sync, history: import("../../dist/index.js").UndoManager, item: Todo, editors: readonly string[],
 *   report: (message: string) => void }} props */
function Item({ sync, history, item, editors, report }) {
  const items = sync.doc.state.items;
  /** @param {Partial<Todo>} change */
  const update = (change) => {
    const index = indexOf(sync, item.id);
    if (index >= 0) items.set(index, { ...item, ...change });
  };
  return h("li", { className: item.done ? "item done" : "item" },
    h("input", { type: "checkbox", checked: item.done, "aria-label": "Done: " + item.title,
      onChange: () => { action(history, report, () => { update({ done: !item.done }); }); } }),
    h("input", { className: "title", value: item.title, "aria-label": "Item title",
      onChange: (/** @type {{ target: HTMLInputElement }} */ event) => { attempt(report, () => { update({ title: event.target.value }); }); },
      onFocus: () => { sync.presence.set({ editing: item.id }); },
      onBlur: () => { sync.presence.set({ editing: null }); } }),
    editors.length > 0 ? h("span", { className: "editing" }, editors.join(", ") + " editing") : null,
    h("button", { type: "button", "aria-label": "Delete " + item.title,
      onClick: () => { action(history, report, () => { const index = indexOf(sync, item.id); if (index >= 0) items.delete(index); }); } }, "×"));
}

/** A writer's view of the shared list. @param {{ writer: Writer, names: ReadonlyMap<string, string> }} props */
function WriterPane({ writer, names }) {
  const { label, sync, history, network } = writer;
  const doc = sync.doc;
  const title = useCollection(doc, "title");
  const items = useCollection(doc, "items");
  const likes = useCollection(doc, "likes");
  const left = useDocument(doc, (state) => state.items.toArray().filter((item) => !item.done).length);
  const { status, push } = useSyncStatus(sync);
  const { canUndo, canRedo } = useUndoState(history);
  const peers = usePeers(sync);
  const [offline, setOffline] = useState(network.offline);
  const [draft, setDraft] = useState("");
  const [message, report] = useState("");
  const badge = describeSync(status, push, offline);
  /** @param {string} id */
  const editors = (id) => [...peers].flatMap(([clientId, state]) => (state.editing === id ? [names.get(clientId) ?? clientId] : []));

  return h("section", { className: "writer", "aria-label": label },
    h("h2", null, label, " ", h("span", { className: "badge", "data-state": badge.state }, badge.text)),
    h("input", { className: "list-title", value: title, "aria-label": label + " list title",
      onChange: (/** @type {{ target: HTMLInputElement }} */ event) => { attempt(report, () => { doc.state.title.value = event.target.value; }); } }),
    h("p", { className: "summary" }, `${items.length} items, ${left} left`),
    h("ul", { className: "items" }, items.map((item) => h(Item, { key: item.id, sync, history, item, editors: editors(item.id), report }))),
    h("form", { className: "add", onSubmit: (/** @type {{ preventDefault(): void }} */ event) => {
      event.preventDefault();
      const text = draft.trim();
      if (text === "") return;
      action(history, report, () => { doc.state.items.push({ id: crypto.randomUUID(), title: text, done: false }); });
      setDraft("");
    } },
    h("input", { value: draft, placeholder: "Add an item", "aria-label": label + " new item",
      onChange: (/** @type {{ target: HTMLInputElement }} */ event) => { setDraft(event.target.value); } }),
    h("button", { type: "submit" }, "Add")),
    h("div", { className: "controls" },
      h("button", { type: "button", className: "like", onClick: () => { action(history, report, () => { doc.state.likes.add(1); }); } }, `👍 ${likes}`),
      h("button", { type: "button", disabled: !canUndo, onClick: () => { attempt(report, () => { history.undo(); }); } }, "Undo"),
      h("button", { type: "button", disabled: !canRedo, onClick: () => { attempt(report, () => { history.redo(); }); } }, "Redo"),
      h("label", null, h("input", { type: "checkbox", checked: offline, onChange: () => {
        network.set(!offline);
        setOffline(!offline);
        if (offline) sync.sync().catch(() => {}); // Back online: catch up now, like the browser's online event.
      } }), " Offline")),
    h("p", { className: "message", "aria-live": "polite" }, message));
}

/** Two writers side by side. @param {{ writers: readonly Writer[], names: ReadonlyMap<string, string> }} props */
export function App({ writers, names }) {
  return h("div", { className: "writers" }, writers.map((writer) => h(WriterPane, { key: writer.label, writer, names })));
}
