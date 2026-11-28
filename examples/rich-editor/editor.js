// @ts-check
import { baseKeymap, lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, Plugin } from "prosemirror-state";
import { editorSchema } from "./schema.js";

/** @typedef {"bold" | "italic" | "code" | "link" | "heading1" | "heading2" | "heading3" | "bullets" | "numbers" | "quote" | "codeBlock" | "undo" | "redo"} Command */
/** @typedef {import("articollab/prosemirror").RemoteSelection} RemoteSelection */
/** @typedef {import("articollab/prosemirror").RemoteSelectionStatus} RemoteStatus */

const { nodes, marks } = editorSchema;
/** @param {string} name */
const nodeType = (name) => { const type = nodes[name]; if (type === undefined) throw new Error("Missing node " + name); return type; };
/** @param {string} name */
const markType = (name) => { const type = marks[name]; if (type === undefined) throw new Error("Missing mark " + name); return type; };

/** Whether the selection is inside a node of `type`. @param {EditorState} state @param {import("prosemirror-model").NodeType} type */
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

/** Another writer's caret, labeled. @param {string} label */
function caret(label) {
  const element = document.createElement("span");
  element.className = "remote-caret";
  element.dataset.label = label;
  element.setAttribute("aria-hidden", "true");
  return element;
}

/**
 * A ProseMirror editor on the Text at `body`, kept in step by `textSync`. Undo, redo and links go to
 * `onCommand`, which owns the undo manager and asks for the address.
 * @param {HTMLElement} parent
 * @param {import("articollab").ClientDocument<typeof import("./schema.js").Note.definition>} doc
 * @param {{ label: string, history: import("articollab").UndoManager, canEdit: () => boolean, onError: (error: unknown) => void,
 *   onChange: (change: { doc: boolean }) => void, onCommand: (command: "link" | "undo" | "redo") => void,
 *   onUnsentComposition: (text: string) => void }} options
 */
export async function createRichEditor(parent, doc, options) {
  // Loaded here: prosemirror-view looks for the DOM as soon as it is imported.
  const { EditorView } = await import("prosemirror-view");
  const { basicMapping, isComposing, remoteSelections, selectionCursors, setRemoteSelections, textSync, textToDoc } =
    await import("articollab/prosemirror");
  // The Text takes headings 1 to 3 and indents up to 8: deeper ones come back within them.
  /** @type {import("articollab/prosemirror").TextMapping} */
  const mapping = { ...basicMapping, heading: { node: "heading", levels: [1, 2, 3] },
    ...(basicMapping.lists === undefined ? {} : { lists: { ...basicMapping.lists, maxIndent: 8 } }) };
  /** @param {"link" | "undo" | "redo"} command */
  const delegate = (command) => () => { options.onCommand(command); return true; };
  /** Keys do nothing while a composition is open: the input method owns them. @param {import("prosemirror-state").Command} command
   * @returns {import("prosemirror-state").Command} */
  const unlessComposing = (command) => (state, dispatch, editorView) =>
    (editorView === undefined || !isComposing(editorView)) && command(state, dispatch, editorView);
  /** @param {Record<string, import("prosemirror-state").Command>} bindings */
  const guarded = (bindings) => keymap(Object.fromEntries(Object.entries(bindings).map(([key, command]) => [key, unlessComposing(command)])));
  const keys = guarded({
    "Mod-z": delegate("undo"), "Mod-Shift-z": delegate("redo"), "Mod-y": delegate("redo"), "Mod-k": delegate("link"),
    "Mod-b": commands.bold, "Mod-i": commands.italic, "Mod-e": commands.code,
    "Mod-Alt-1": commands.heading1, "Mod-Alt-2": commands.heading2, "Mod-Alt-3": commands.heading3,
    "Mod-Shift-8": commands.bullets, "Mod-Shift-7": commands.numbers,
    Enter: splitListItem(nodeType("list_item")), Tab: sinkListItem(nodeType("list_item")), "Shift-Tab": liftListItem(nodeType("list_item")),
  });
  let editable = false, destroyed = false, wasComposing = false;
  /** A read-only change that waits for the composition to end. @type {boolean | undefined} */
  let pendingReadOnly;
  /** Reports changes, and applies a read-only change that waited for a composition. */
  const watch = new Plugin({
    view: () => ({
      update(current, previous) {
        if (pendingReadOnly !== undefined && !isComposing(current)) {
          const value = pendingReadOnly;
          pendingReadOnly = undefined;
          queueMicrotask(() => { setReadOnly(value); });
        }
        const changed = previous.doc !== current.state.doc, composing = isComposing(current);
        // A composition that ended moves the caret to its text, even when the editor already shows it.
        const ended = wasComposing && !composing;
        wasComposing = composing;
        if (changed || ended || !previous.selection.eq(current.state.selection)) options.onChange({ doc: changed || ended });
      },
    }),
  });
  const view = new EditorView(parent, {
    state: EditorState.create({
      doc: textToDoc(doc.state.body, editorSchema, mapping),
      plugins: [
        textSync(doc, "body", { mapping, history: options.history, canEdit: options.canEdit, onError: options.onError,
          onUnsentComposition: options.onUnsentComposition }),
        remoteSelections({ selectionClass: "remote-selection", caret }),
        keys, guarded(baseKeymap), watch,
      ],
    }),
    editable: () => editable,
    attributes: { "aria-label": options.label, class: "rich-text" },
  });
  /** @param {boolean} value */
  function setReadOnly(value) {
    if (destroyed) return;
    if (isComposing(view)) { pendingReadOnly = value; return; }
    editable = !value;
    view.setProps({ editable: () => editable });
  }

  return {
    get view() { return view; },
    /** @param {Exclude<Command, "link" | "undo" | "redo">} command */
    run(command) {
      if (isComposing(view)) return false;
      const ran = commands[command](view.state, view.dispatch.bind(view));
      view.focus();
      return ran;
    },
    /** Adds a link to the selection, or removes the one it has. @param {string} href */
    link(href) {
      const type = markType("link"), { from, to, empty } = view.state.selection;
      if (empty || isComposing(view)) return false;
      const tr = view.state.doc.rangeHasMark(from, to, type)
        ? view.state.tr.removeMark(from, to, type) : view.state.tr.addMark(from, to, type.create({ href }));
      view.dispatch(tr);
      return true;
    },
    selectionCursors: () => selectionCursors(view.state),
    /** Replaces the other writers' selections. @param {readonly RemoteSelection[]} selections */
    setRemote: (selections) => setRemoteSelections(view, selections),
    isComposing: () => isComposing(view),
    setReadOnly,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      view.destroy();
    },
  };
}
