// @ts-check
import { createElement as h, useEffect, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { usePeers, useSyncStatus, useUndoState } from "articollab/react";
import { ArticollabText, isComposing, selectionCursors, setRemoteSelections, starterKitMapping } from "articollab/tiptap";
import { selectionOf } from "../shared/presence.js";
import { describeSync } from "../shared/sync-ui.js";

/** @typedef {import("./schema.js").Shape} Shape */
/** @typedef {import("articollab/sync").PresenceSyncClient<Shape, import("../shared/presence.js").SelectionPresence>} Sync */
/** @typedef {import("@tiptap/core").Editor} Editor */
/** @typedef {import("@tiptap/core").ChainedCommands} Chain */

/**
 * One writer: a sync client with presence, its undo manager, and a network switch to go offline.
 * @typedef {{ readonly label: string, readonly sync: Sync, readonly history: import("articollab").UndoManager,
 *   readonly network: { readonly offline: boolean, set(offline: boolean): void } }} Writer
 */

/** The Text takes headings 1 to 3 and indents up to 8: others come back within them. */
const mapping = { ...starterKitMapping, heading: { node: "heading", levels: [1, 2, 3] },
  ...(starterKitMapping.lists === undefined ? {} : { lists: { ...starterKitMapping.lists, maxIndent: 8 } }) };
const LANGUAGES = ["js", "ts", "py", "sh"];

/** Toolbar buttons: name, label, title, what it runs and whether it is active. */
/** @type {readonly (readonly [string, string, string, (chain: Chain) => Chain, (editor: Editor) => boolean])[]} */
const TOOLS = [
  ["bold", "B", "Bold (Ctrl+B)", (chain) => chain.toggleBold(), (editor) => editor.isActive("bold")],
  ["italic", "I", "Italic (Ctrl+I)", (chain) => chain.toggleItalic(), (editor) => editor.isActive("italic")],
  ["strike", "S", "Strikethrough (Ctrl+Shift+S)", (chain) => chain.toggleStrike(), (editor) => editor.isActive("strike")],
  ["underline", "U", "Underline (Ctrl+U)", (chain) => chain.toggleUnderline(), (editor) => editor.isActive("underline")],
  ["code", "Code", "Code (Ctrl+E)", (chain) => chain.toggleCode(), (editor) => editor.isActive("code")],
  ["heading1", "H1", "Heading 1 (Ctrl+Alt+1)", (chain) => chain.toggleHeading({ level: 1 }), (editor) => editor.isActive("heading", { level: 1 })],
  ["heading2", "H2", "Heading 2 (Ctrl+Alt+2)", (chain) => chain.toggleHeading({ level: 2 }), (editor) => editor.isActive("heading", { level: 2 })],
  ["heading3", "H3", "Heading 3 (Ctrl+Alt+3)", (chain) => chain.toggleHeading({ level: 3 }), (editor) => editor.isActive("heading", { level: 3 })],
  ["bullets", "• List", "Bullet list (Ctrl+Shift+8)", (chain) => chain.toggleBulletList(), (editor) => editor.isActive("bulletList")],
  ["numbers", "1. List", "Numbered list (Ctrl+Shift+7)", (chain) => chain.toggleOrderedList(), (editor) => editor.isActive("orderedList")],
  ["quote", "Quote", "Quote (Ctrl+Shift+B)", (chain) => chain.toggleBlockquote(), (editor) => editor.isActive("blockquote")],
  ["codeBlock", "{ }", "Code block (Ctrl+Alt+C)", (chain) => chain.toggleCodeBlock(), (editor) => editor.isActive("codeBlock")],
];

/** Another writer's caret, labeled. @param {string} label */
function caret(label) {
  const element = document.createElement("span");
  element.className = "remote-caret";
  element.dataset.label = label;
  element.setAttribute("aria-hidden", "true");
  return element;
}

/** Whether the writer may send edits: not after a failure or a history gap. @param {Sync} sync */
const canEdit = (sync) => sync.status !== "failed" && sync.status !== "gap" && sync.status !== "closed";

/** One writer's editor, toolbar and controls. @param {{ writer: Writer, names: ReadonlyMap<string, string> }} props */
function WriterPane({ writer, names }) {
  const { label, sync, history, network } = writer;
  const [message, report] = useState("");
  const [offline, setOffline] = useState(network.offline);
  const { status, push } = useSyncStatus(sync);
  const { canUndo, canRedo } = useUndoState(history);
  const peers = usePeers(sync);
  const badge = describeSync(status, push, offline);

  const editor = useEditor({
    extensions: [
      // Undo goes through the Text, and a trailing paragraph would be added by every writer.
      StarterKit.configure({ undoRedo: false, trailingNode: false, heading: { levels: [1, 2, 3] }, link: { openOnClick: false } }),
      ArticollabText.configure({
        document: sync.doc, path: "body", history, mapping, canEdit: () => canEdit(sync),
        onError(error) { report("Stopped: " + (error instanceof Error ? error.message : String(error)) + ". Reload to continue."); },
        onUnsentComposition(text) { report("The composition could not be saved (" + sync.status + "). Copy it from here: " + text); },
        remoteSelections: { selectionClass: "remote-selection", caret },
      }),
    ],
    editorProps: { attributes: { "aria-label": label + " text", class: "rich-text" } },
  }, [sync, history]);

  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      tools: Object.fromEntries(TOOLS.map(([name, , , , isActive]) => [name, isActive(current)])),
      link: current.isActive("link"),
      language: current.isActive("codeBlock") ? String(current.getAttributes("codeBlock").language ?? "") : null,
    }),
  });

  // Share this writer's selection; the editor shows the Text again after a composition, which shares it too.
  useEffect(() => {
    const share = () => {
      if (isComposing(editor.view)) return;
      try { sync.presence.set({ selection: selectionCursors(editor.state) ?? null }); } catch { /* Closed. */ }
    };
    share();
    editor.on("transaction", share);
    return () => { editor.off("transaction", share); };
  }, [editor, sync]);

  // Draw the other writers' selections where their text is.
  useEffect(() => {
    setRemoteSelections(editor.view, [...peers].flatMap(([clientId, state]) => {
      const selection = selectionOf(state);
      return selection === null ? [] : [{ label: names.get(clientId) ?? clientId, selection }];
    }));
  }, [editor, peers, names]);

  /** Runs a toolbar command on the selection; nothing while an input method composes. @param {(chain: Chain) => Chain} command */
  const run = (command) => {
    if (isComposing(editor.view)) return;
    if (!command(editor.chain().focus()).run()) report("Not available here.");
    else report("");
  };
  const link = () => {
    if (editor.isActive("link")) { run((chain) => chain.extendMarkRange("link").unsetLink()); return; }
    if (editor.state.selection.empty) { report("Select some text first."); return; }
    const href = prompt("Link address (the server keeps only http: and https: links)", "https://");
    if (href === null || href === "") return;
    // Tiptap's link extension refuses addresses such as javascript:, as the server would.
    report(editor.chain().focus().setLink({ href }).run() ? "" : "Not a link address Tiptap accepts: use http: or https:.");
  };
  /** @param {string} language */
  const setLanguage = (language) => {
    if (editor.isActive("codeBlock")) run((chain) => chain.updateAttributes("codeBlock", { language: language === "" ? null : language }));
    else run((chain) => (language === "" ? chain.setCodeBlock() : chain.setCodeBlock({ language })));
  };

  return h("section", { className: "writer", "aria-label": label },
    h("h2", null, label, " ", h("span", { className: "badge", "data-state": badge.state }, badge.text)),
    h("div", { className: "toolbar", role: "toolbar", "aria-label": label + " formatting" },
      ...TOOLS.map(([name, text, title, command]) => h("button", {
        key: name, type: "button", className: "tool-" + name, title, "aria-pressed": active.tools[name] === true,
        // Keep the editor's selection: a click would otherwise move focus first.
        onMouseDown: (/** @type {{ preventDefault(): void }} */ event) => { event.preventDefault(); },
        onClick: () => { run(command); },
      }, text)),
      h("button", { key: "link", type: "button", className: "tool-link", title: "Link", "aria-pressed": active.link,
        onMouseDown: (/** @type {{ preventDefault(): void }} */ event) => { event.preventDefault(); }, onClick: link }, "Link"),
      h("select", { key: "language", className: "language", "aria-label": label + " code language", value: active.language ?? "",
        onChange: (/** @type {{ target: HTMLSelectElement }} */ event) => { setLanguage(event.target.value); } },
      h("option", { value: "" }, active.language === null ? "Code block…" : "Plain"),
      ...LANGUAGES.map((language) => h("option", { key: language, value: language }, language))),
      h("button", { key: "undo", type: "button", disabled: !canUndo, title: "Undo (Ctrl+Z)", onClick: () => { run((chain) => chain.undo()); } }, "Undo"),
      h("button", { key: "redo", type: "button", disabled: !canRedo, title: "Redo (Ctrl+Shift+Z)", onClick: () => { run((chain) => chain.redo()); } }, "Redo")),
    h("div", { className: "editor" }, h(EditorContent, { editor })),
    h("p", { className: "presence" }, peers.size === 0 ? "No other writer is here." :
      [...peers.keys()].map((clientId) => names.get(clientId) ?? clientId).join(", ") + " is here."),
    h("div", { className: "controls" },
      h("label", null, h("input", { type: "checkbox", checked: offline, onChange: () => {
        network.set(!offline);
        setOffline(!offline);
        if (offline) sync.sync().catch(() => {}); // Back online: catch up now, like the browser's online event.
      } }), " Offline")),
    h("p", { className: "message", "aria-live": "polite" }, message));
}

/** Two writers side by side. @param {{ writers: readonly Writer[], names: ReadonlyMap<string, string> }} props */
export function App({ writers, names }) {
  return h("div", { className: "editors" }, writers.map((writer) => h(WriterPane, { key: writer.label, writer, names })));
}
