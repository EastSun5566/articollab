// @ts-check
import { Compartment, EditorState } from "@codemirror/state";
import { createTextBinding, formatRanges, remoteRanges } from "./binding.js";

/** @param {HTMLElement} parent
 * @param {Parameters<typeof createTextBinding>[0]} doc
 * @param {{label: string, canEdit: () => boolean, onError: (error: unknown) => void,
 *   onLocalEdit: () => void, onComposition: () => void, onSelection: () => void,
 *   onShortcut: (command: "bold" | "italic" | "link" | "undo" | "redo") => void,
 *   onRemote: (statuses: readonly import("./binding.js").RemoteStatus[]) => void}} options
 */
export async function createTextEditor(parent, doc, options) {
  const { Decoration, EditorView, WidgetType, keymap } = await import("@codemirror/view");
  class RemoteCaret extends WidgetType {
    /** @param {string} label */
    constructor(label) { super(); this.label = label; }
    /** @param {RemoteCaret} other */
    eq(other) { return other.label === this.label; }
    toDOM() {
      const caret = document.createElement("span");
      caret.className = "cm-remote-caret";
      caret.setAttribute("aria-hidden", "true");
      caret.dataset.label = this.label;
      return caret;
    }
    ignoreEvent() { return true; }
  }
  // Ranges come from the binding's state field, so decorations always match the rendered document.
  const remoteDecorations = EditorView.decorations.compute([remoteRanges], (state) => Decoration.set(
    state.field(remoteRanges).flatMap(({ label, from, to }) => [
      ...(from < to ? [Decoration.mark({ class: "cm-remote-selection", attributes: { title: label } }).range(from, to)] : []),
      Decoration.widget({ widget: new RemoteCaret(label), side: from < to ? 1 : -1 }).range(to),
    ]), true));
  const formatDecorations = EditorView.decorations.compute([formatRanges], (state) => Decoration.set(
    state.field(formatRanges).map(({ from, to, attributes }) => {
      const classes = ["bold", "italic", "link"].filter((key) => attributes[key] !== undefined).map((key) => "cm-format-" + key);
      const link = attributes.link;
      return Decoration.mark({ class: classes.join(" "), ...(typeof link === "string" ? { attributes: { title: link } } : {}) })
        .range(from, to);
    }), true));
  /** @param {"bold" | "italic" | "link" | "undo" | "redo"} command */
  const run = (command) => () => { options.onShortcut(command); return true; };
  const shortcuts = keymap.of([
    { key: "Mod-b", run: run("bold") }, { key: "Mod-i", run: run("italic") }, { key: "Mod-k", run: run("link") },
    { key: "Mod-z", run: run("undo"), shift: run("redo") }, { key: "Mod-y", run: run("redo") },
  ]);
  const readOnly = new Compartment();
  let composing = false;
  /** @type {import("@codemirror/view").EditorView | undefined} */
  let view;
  const binding = createTextBinding(doc, {
    canEdit: options.canEdit, onError: options.onError, onLocalEdit: options.onLocalEdit,
    onSelection: options.onSelection, onRemote: options.onRemote,
    extensions: [readOnly.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]), remoteDecorations,
      formatDecorations, shortcuts,
      EditorView.contentAttributes.of({ "aria-label": options.label }),
      EditorView.lineWrapping],
    update: (transactions) => { view?.update(transactions); },
  });
  try {
    view = new EditorView({ state: binding.state, parent, dispatchTransactions: binding.dispatch });
  } catch (error) { binding.destroy(); throw error; }
  const mounted = view;
  function compositionStart() { composing = true; options.onComposition(); }
  function compositionEnd() { composing = false; options.onComposition(); }
  mounted.contentDOM.addEventListener("compositionstart", compositionStart);
  mounted.contentDOM.addEventListener("compositionend", compositionEnd);
  let destroyed = false;
  return {
    isComposing: () => composing || mounted.compositionStarted || mounted.composing,
    selectionCursors: () => binding.selectionCursors(),
    /** @param {Parameters<typeof binding.toggleMark>[0]} key @param {string | true} value */
    toggleMark: (key, value) => binding.toggleMark(key, value),
    /** @param {readonly import("./binding.js").RemoteSelection[]} selections */
    setRemote: (selections) => binding.setRemote(selections),
    /** @param {boolean} value */
    setReadOnly(value) {
      binding.dispatch([binding.state.update({ effects: readOnly.reconfigure([
        EditorState.readOnly.of(value), EditorView.editable.of(!value),
      ]) })]);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      binding.destroy();
      mounted.contentDOM.removeEventListener("compositionstart", compositionStart);
      mounted.contentDOM.removeEventListener("compositionend", compositionEnd);
      mounted.destroy();
    },
  };
}
