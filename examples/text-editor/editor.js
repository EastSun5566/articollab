// @ts-check
import { Compartment, EditorState } from "@codemirror/state";
import { createTextBinding, remoteRanges } from "./binding.js";

/** @param {HTMLElement} parent
 * @param {Parameters<typeof createTextBinding>[0]} doc
 * @param {{label: string, canEdit: () => boolean, onError: (error: unknown) => void,
 *   onLocalEdit: () => void, onComposition: () => void, onSelection: () => void,
 *   onRemote: (statuses: readonly import("./binding.js").RemoteStatus[]) => void}} options
 */
export async function createTextEditor(parent, doc, options) {
  const { Decoration, EditorView, WidgetType } = await import("@codemirror/view");
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
  const readOnly = new Compartment();
  let composing = false;
  /** @type {import("@codemirror/view").EditorView | undefined} */
  let view;
  const binding = createTextBinding(doc, {
    canEdit: options.canEdit, onError: options.onError, onLocalEdit: options.onLocalEdit,
    onSelection: options.onSelection, onRemote: options.onRemote,
    extensions: [readOnly.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]), remoteDecorations,
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
