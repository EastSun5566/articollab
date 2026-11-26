// @ts-check
import { baseKeymap, lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { Plugin, PluginKey } from "prosemirror-state";
import { createRichTextBinding } from "./binding.js";
import { editorSchema } from "./schema.js";

/** @typedef {"bold" | "italic" | "code" | "link" | "heading1" | "heading2" | "heading3" | "bullets" | "numbers" | "quote" | "codeBlock" | "undo" | "redo"} Command */
/** @typedef {{ readonly label: string, readonly selection: import("./binding.js").CursorSelection }} RemoteSelection */
/** Whether a remote selection resolved here. @typedef {{ readonly label: string, readonly resolved: boolean }} RemoteStatus */

const { nodes, marks } = editorSchema;
/** @param {string} name */
const nodeType = (name) => { const type = nodes[name]; if (type === undefined) throw new Error("Missing node " + name); return type; };
/** @param {string} name */
const markType = (name) => { const type = marks[name]; if (type === undefined) throw new Error("Missing mark " + name); return type; };

/** Whether the selection is inside a node of `type`. @param {import("prosemirror-state").EditorState} state @param {import("prosemirror-model").NodeType} type */
function inside(state, type) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type === type) return true;
  return false;
}

/** Toggles the selection's paragraphs between `type` and a plain paragraph.
 * @param {import("prosemirror-model").NodeType} type @param {Record<string, unknown>} [attrs] @returns {import("prosemirror-state").Command} */
function toggleBlock(type, attrs = {}) {
  return (state, dispatch) => {
    const parent = state.selection.$from.parent;
    const active = parent.type === type && Object.entries(attrs).every(([key, value]) => parent.attrs[key] === value);
    return active ? setBlockType(nodeType("paragraph"))(state, dispatch) : setBlockType(type, attrs)(state, dispatch);
  };
}

/** Puts the selection in a list of `type`, takes it out of one, or switches the kind of list.
 * @param {import("prosemirror-model").NodeType} type @returns {import("prosemirror-state").Command} */
function toggleList(type) {
  return (state, dispatch) => {
    const item = nodeType("list_item");
    if (inside(state, type)) return liftListItem(item)(state, dispatch);
    return wrapInList(type)(state, dispatch);
  };
}

/** @type {Record<Exclude<Command, "link" | "undo" | "redo">, import("prosemirror-state").Command>} */
const commands = {
  bold: toggleMark(markType("strong")),
  italic: toggleMark(markType("em")),
  code: toggleMark(markType("code")),
  heading1: toggleBlock(nodeType("heading"), { level: 1 }),
  heading2: toggleBlock(nodeType("heading"), { level: 2 }),
  heading3: toggleBlock(nodeType("heading"), { level: 3 }),
  bullets: toggleList(nodeType("bullet_list")),
  numbers: toggleList(nodeType("ordered_list")),
  quote: (state, dispatch) => (inside(state, nodeType("blockquote")) ? lift(state, dispatch) : wrapIn(nodeType("blockquote"))(state, dispatch)),
  codeBlock: toggleBlock(nodeType("code_block")),
};

/**
 * A ProseMirror editor bound to a Text. Undo, redo and links go to `onCommand`, which owns the undo
 * manager and asks for the address. An input method composition is written once it is confirmed, and
 * not at all when Escape cancels it.
 * @param {HTMLElement} parent
 * @param {Parameters<typeof createRichTextBinding>[0]} doc
 * @param {{ label: string, canEdit: () => boolean, onError: (error: unknown) => void, onLocalEdit: () => void,
 *   onSelection: () => void, onRemote: () => void, onCommand: (command: "link" | "undo" | "redo") => void,
 *   onCompositionBoundary: () => void, onUnsentComposition: (text: string) => void }} options
 */
export async function createRichEditor(parent, doc, options) {
  // Loaded here: prosemirror-view looks for the DOM as soon as it is imported.
  const { Decoration, DecorationSet, EditorView } = await import("prosemirror-view");
  /** @type {PluginKey<import("prosemirror-view").DecorationSet>} */
  const remoteKey = new PluginKey("remote-selections");
  /** @type {readonly RemoteSelection[]} */
  let remote = [];
  /** @type {Plugin<import("prosemirror-view").DecorationSet>} */
  const remoteSelections = new Plugin({
    key: remoteKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const next = /** @type {unknown} */ (tr.getMeta(remoteKey));
        return next instanceof DecorationSet ? next : set.map(tr.mapping, tr.doc);
      },
    },
    props: { decorations: (state) => remoteKey.getState(state) },
  });
  /** @param {"link" | "undo" | "redo"} command */
  const delegate = (command) => () => { options.onCommand(command); return true; };
  /** Keys do nothing while a composition is open: the input method owns them. @param {import("prosemirror-state").Command} command
   * @returns {import("prosemirror-state").Command} */
  const unlessComposing = (command) => (state, dispatch, editorView) => !isComposing() && command(state, dispatch, editorView);
  /** @param {Record<string, import("prosemirror-state").Command>} bindings */
  const guarded = (bindings) => keymap(Object.fromEntries(Object.entries(bindings).map(([key, command]) => [key, unlessComposing(command)])));
  const keys = guarded({
    "Mod-z": delegate("undo"), "Mod-Shift-z": delegate("redo"), "Mod-y": delegate("redo"), "Mod-k": delegate("link"),
    "Mod-b": commands.bold, "Mod-i": commands.italic, "Mod-e": commands.code,
    "Mod-Alt-1": commands.heading1, "Mod-Alt-2": commands.heading2, "Mod-Alt-3": commands.heading3,
    "Mod-Shift-8": commands.bullets, "Mod-Shift-7": commands.numbers,
    Enter: splitListItem(nodeType("list_item")), Tab: sinkListItem(nodeType("list_item")), "Shift-Tab": liftListItem(nodeType("list_item")),
  });
  let editable = false, destroyed = false, cancelled = false;
  /** A read-only change that waits for the composition to end. @type {boolean | undefined} */
  let pendingReadOnly;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let ending;
  /** @type {import("prosemirror-view").EditorView | undefined} */
  let view;
  const isComposing = () => binding.composing || view?.composing === true;
  /** Ends the composition once ProseMirror has read its final text. */
  const compositionWatch = new Plugin({
    view: () => ({ update(current) { if (binding.composing && !current.composing) scheduleFinish(); } }),
  });
  const binding = createRichTextBinding(doc, {
    plugins: [keys, guarded(baseKeymap), remoteSelections, compositionWatch],
    update: (state) => { view?.updateState(state); },
    canEdit: options.canEdit, onError: options.onError, onLocalEdit: options.onLocalEdit, onSelection: options.onSelection,
    onRemote() { options.onRemote(); },
    onCompositionBoundary: options.onCompositionBoundary, onUnsentComposition: options.onUnsentComposition,
  });

  function finish() {
    clearTimeout(ending);
    ending = undefined;
    if (destroyed || !binding.composing) return;
    try { binding.finishComposition(cancelled); }
    catch { /* The binding has already reported the error. */ }
    if (pendingReadOnly !== undefined) {
      const value = pendingReadOnly;
      pendingReadOnly = undefined;
      setReadOnly(value);
    }
    // Other writers' selections waited too.
    options.onRemote();
  }
  // ProseMirror reads the final text in a microtask after compositionend.
  function scheduleFinish() {
    ending ??= setTimeout(() => { ending = undefined; if (!view?.composing) finish(); }, 0);
  }
  const mounted = new EditorView(parent, {
    state: binding.state,
    dispatchTransaction(tr) {
      // A composition that started before its compositionstart event reached this editor.
      if (!binding.composing && view?.composing === true && tr.getMeta("composition") !== undefined) binding.startComposition();
      binding.dispatch(tr);
    },
    editable: () => editable,
    attributes: { "aria-label": options.label, class: "rich-text" },
    handleDOMEvents: {
      compositionstart() {
        if (ending !== undefined) finish();
        if (!binding.composing) { cancelled = false; binding.startComposition(); }
        return false;
      },
      compositionend() { scheduleFinish(); return false; },
      keydown(current, event) {
        // A key after the composition, which ProseMirror may end without compositionend: write it first.
        if (binding.composing && !current.composing) finish();
        // macOS Zhuyin can end an Escape cancellation with the phonetic text still in the editor.
        else if (binding.composing && event.key === "Escape") cancelled = true;
        else if (binding.composing && event.isComposing) cancelled = false;
        return false;
      },
    },
  });
  view = mounted;
  /** @param {boolean} value */
  function setReadOnly(value) {
    if (destroyed) return;
    if (binding.composing) { pendingReadOnly = value; return; }
    editable = !value;
    mounted.setProps({ editable: () => editable });
  }

  /** Draws the other writers' selections where they are now. @returns {RemoteStatus[]} */
  function drawRemote() {
    /** @type {import("prosemirror-view").Decoration[]} */
    const decorations = [];
    const statuses = remote.map(({ label, selection }) => {
      const range = binding.resolve(selection);
      if (range === undefined) return { label, resolved: false };
      if (range.from < range.to) decorations.push(Decoration.inline(range.from, range.to, { class: "remote-selection", title: label }));
      decorations.push(Decoration.widget(range.to, () => {
        const caret = document.createElement("span");
        caret.className = "remote-caret";
        caret.dataset.label = label;
        caret.setAttribute("aria-hidden", "true");
        return caret;
      }, { key: label + ":" + String(range.to), side: range.from < range.to ? 1 : -1 }));
      return { label, resolved: true };
    });
    mounted.dispatch(mounted.state.tr.setMeta(remoteKey, DecorationSet.create(mounted.state.doc, decorations)));
    return statuses;
  }

  return {
    get view() { return mounted; },
    /** @param {Exclude<Command, "link" | "undo" | "redo">} command */
    run(command) {
      if (isComposing()) return false;
      const ran = commands[command](mounted.state, mounted.dispatch.bind(mounted));
      mounted.focus();
      return ran;
    },
    /** Adds a link to the selection, or removes the one it has. @param {string} href */
    link(href) {
      const type = markType("link"), { from, to, empty } = mounted.state.selection;
      if (empty || isComposing()) return false;
      const tr = mounted.state.doc.rangeHasMark(from, to, type)
        ? mounted.state.tr.removeMark(from, to, type) : mounted.state.tr.addMark(from, to, type.create({ href }));
      mounted.dispatch(tr);
      return true;
    },
    selectionCursors: () => binding.selectionCursors(),
    /** Replaces the other writers' selections. @param {readonly RemoteSelection[]} selections */
    setRemote(selections) { remote = selections; return drawRemote(); },
    redrawRemote: () => drawRemote(),
    isComposing,
    setReadOnly,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(ending);
      binding.destroy();
      mounted.destroy();
    },
  };
}
