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
 * manager and asks for the address.
 * @param {HTMLElement} parent
 * @param {Parameters<typeof createRichTextBinding>[0]} doc
 * @param {{ label: string, canEdit: () => boolean, onError: (error: unknown) => void, onLocalEdit: () => void,
 *   onSelection: () => void, onRemote: () => void, onCommand: (command: "link" | "undo" | "redo") => void }} options
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
  const keys = keymap({
    "Mod-z": delegate("undo"), "Mod-Shift-z": delegate("redo"), "Mod-y": delegate("redo"), "Mod-k": delegate("link"),
    "Mod-b": commands.bold, "Mod-i": commands.italic, "Mod-e": commands.code,
    "Mod-Alt-1": commands.heading1, "Mod-Alt-2": commands.heading2, "Mod-Alt-3": commands.heading3,
    "Mod-Shift-8": commands.bullets, "Mod-Shift-7": commands.numbers,
    Enter: splitListItem(nodeType("list_item")), Tab: sinkListItem(nodeType("list_item")), "Shift-Tab": liftListItem(nodeType("list_item")),
  });
  let editable = false;
  /** @type {import("prosemirror-view").EditorView | undefined} */
  let view;
  const binding = createRichTextBinding(doc, {
    plugins: [keys, keymap(baseKeymap), remoteSelections],
    update: (state) => { view?.updateState(state); },
    canEdit: options.canEdit, onError: options.onError, onLocalEdit: options.onLocalEdit, onSelection: options.onSelection,
    onRemote() { options.onRemote(); },
  });
  const mounted = new EditorView(parent, {
    state: binding.state,
    dispatchTransaction: (tr) => { binding.dispatch(tr); },
    editable: () => editable,
    attributes: { "aria-label": options.label, class: "rich-text" },
  });
  view = mounted;

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
    run(command) { const ran = commands[command](mounted.state, mounted.dispatch.bind(mounted)); mounted.focus(); return ran; },
    /** Adds a link to the selection, or removes the one it has. @param {string} href */
    link(href) {
      const type = markType("link"), { from, to, empty } = mounted.state.selection;
      if (empty) return false;
      const tr = mounted.state.doc.rangeHasMark(from, to, type)
        ? mounted.state.tr.removeMark(from, to, type) : mounted.state.tr.addMark(from, to, type.create({ href }));
      mounted.dispatch(tr);
      return true;
    },
    selectionCursors: () => binding.selectionCursors(),
    /** Replaces the other writers' selections. @param {readonly RemoteSelection[]} selections */
    setRemote(selections) { remote = selections; return drawRemote(); },
    redrawRemote: () => drawRemote(),
    isComposing: () => mounted.composing,
    /** @param {boolean} value */
    setReadOnly(value) { editable = !value; mounted.setProps({ editable: () => editable }); },
    destroy() { binding.destroy(); mounted.destroy(); },
  };
}
