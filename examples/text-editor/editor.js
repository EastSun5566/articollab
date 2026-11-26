// @ts-check
import { Compartment, EditorState } from "@codemirror/state";
import { blockLines, createTextBinding, formatRanges, remoteRanges } from "./binding.js";

/** @typedef {"bold" | "italic" | "link" | "heading1" | "heading2" | "list" | "undo" | "redo"} Command */

/** @param {HTMLElement} parent
 * @param {Parameters<typeof createTextBinding>[0]} doc
 * @param {{label: string, canEdit: () => boolean, onError: (error: unknown) => void,
 *   onLocalEdit: () => void, onComposition: () => void, onSelection: () => void,
 *   onCompositionBoundary: () => void, onUnsentComposition: (text: string) => void,
 *   onShortcut: (command: Command) => void,
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
  const lineDecorations = EditorView.decorations.compute([blockLines], (state) => Decoration.set(
    state.field(blockLines).map(({ from, attributes }) => Decoration.line({ class: [
      ...(attributes.heading === 1 || attributes.heading === 2 ? ["cm-heading-" + String(attributes.heading)] : []),
      ...(attributes.list === "bullet" ? ["cm-list-bullet"] : []),
    ].join(" ") }).range(from)), true));
  const isComposing = () => binding.composing || view?.compositionStarted === true;
  /** @param {Command} command */
  const run = (command) => () => {
    if (isComposing()) return false;
    options.onShortcut(command);
    return true;
  };
  const shortcuts = keymap.of([
    { key: "Enter", run: () => !isComposing() && binding.enter() },
    { key: "Mod-Alt-1", run: run("heading1") }, { key: "Mod-Alt-2", run: run("heading2") }, { key: "Mod-Shift-8", run: run("list") },
    { key: "Mod-b", run: run("bold") }, { key: "Mod-i", run: run("italic") }, { key: "Mod-k", run: run("link") },
    { key: "Mod-z", run: run("undo"), shift: run("redo") }, { key: "Mod-y", run: run("redo") },
  ]);
  const readOnly = new Compartment();
  let destroyed = false, ending = false, cancelled = false, generation = 0;
  /** @type {number | undefined} */
  let scheduled;
  /** @type {boolean | undefined} */
  let pendingReadOnly;
  /** @type {EventTarget | undefined} */
  let editContext;
  /** @type {import("@codemirror/view").EditorView | undefined} */
  let view;
  const binding = createTextBinding(doc, {
    canEdit: options.canEdit, onError: options.onError, onLocalEdit: options.onLocalEdit,
    onSelection: options.onSelection, onRemote: options.onRemote,
    onCompositionBoundary: options.onCompositionBoundary, onUnsentComposition: options.onUnsentComposition,
    extensions: [readOnly.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]), remoteDecorations,
      formatDecorations, lineDecorations, shortcuts,
      EditorView.contentAttributes.of({ "aria-label": options.label }),
      EditorView.updateListener.of(({ view: current }) => {
        if (binding.composing && !current.compositionStarted) compositionEnd();
      }),
      EditorView.lineWrapping],
    update: (transactions) => { view?.update(transactions); },
  });
  try {
    view = new EditorView({ state: binding.state, parent, dispatchTransactions(transactions, current) {
      if (current.compositionStarted || transactions.some((transaction) => transaction.isUserEvent("input.type.compose"))) {
        if (!binding.composing) compositionStart();
      }
      binding.dispatch(transactions);
    } });
  } catch (error) { binding.destroy(); throw error; }
  const mounted = view;

  function finishComposition() {
    if (!binding.composing) return;
    ending = false;
    try { binding.finishComposition(cancelled); }
    catch { /* The binding has already reported the error. */ }
    if (pendingReadOnly !== undefined) {
      const value = pendingReadOnly;
      pendingReadOnly = undefined;
      setReadOnly(value);
    }
    options.onComposition();
  }
  function compositionStart() {
    if (ending && !view?.compositionStarted) finishComposition();
    if (!binding.composing) {
      generation++;
      cancelled = false;
      binding.startComposition();
    }
  }
  /** @param {KeyboardEvent} event */
  function compositionKey(event) {
    if (!binding.composing || ending) return;
    // macOS Zhuyin may end an Escape cancellation with the phonetic text still in the view.
    if (event.key === "Escape") cancelled = true;
    else if (event.isComposing || view?.compositionStarted) cancelled = false;
  }
  function compositionEnd() {
    if (!binding.composing) return;
    ending = true;
    const current = generation;
    if (scheduled === current) return;
    scheduled = current;
    // CodeMirror can apply the final DOM changes in a microtask after compositionend.
    queueMicrotask(() => {
      if (scheduled === current) scheduled = undefined;
      if (!destroyed && generation === current && !mounted.compositionStarted) finishComposition();
    });
  }
  /** @param {EventTarget | undefined} next */
  function watchEditContext(next) {
    if (editContext === next) return;
    editContext?.removeEventListener("compositionstart", compositionStart, true);
    editContext?.removeEventListener("compositionend", compositionEnd);
    editContext = next;
    editContext?.addEventListener("compositionstart", compositionStart, true);
    editContext?.addEventListener("compositionend", compositionEnd);
  }
  /** @param {boolean} value */
  function setReadOnly(value) {
    if (destroyed) return;
    if (binding.composing) { pendingReadOnly = value; return; }
    binding.dispatch([binding.state.update({ effects: readOnly.reconfigure([
      EditorState.readOnly.of(value), EditorView.editable.of(!value),
    ]) })]);
    // CodeMirror can attach or detach the native EditContext when editable changes.
    const content = mounted.contentDOM;
    const context = "editContext" in content ? content.editContext : undefined;
    watchEditContext(context instanceof EventTarget ? context : undefined);
  }
  mounted.contentDOM.addEventListener("compositionstart", compositionStart, true);
  mounted.contentDOM.addEventListener("compositionend", compositionEnd);
  mounted.contentDOM.addEventListener("keydown", compositionKey, true);
  return {
    isComposing,
    selectionCursors: () => binding.selectionCursors(),
    /** @param {Parameters<typeof binding.toggleMark>[0]} key @param {string | true} value */
    toggleMark: (key, value) => binding.toggleMark(key, value),
    /** @param {Parameters<typeof binding.toggleBlock>[0]} attribute */
    toggleBlock: (attribute) => binding.toggleBlock(attribute),
    /** @param {readonly import("./binding.js").RemoteSelection[]} selections */
    setRemote: (selections) => binding.setRemote(selections),
    setReadOnly,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      binding.destroy();
      mounted.contentDOM.removeEventListener("compositionstart", compositionStart, true);
      mounted.contentDOM.removeEventListener("compositionend", compositionEnd);
      mounted.contentDOM.removeEventListener("keydown", compositionKey, true);
      watchEditContext(undefined);
      mounted.destroy();
    },
  };
}
