import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Window } from "happy-dom";
import { toggleMark } from "prosemirror-commands";
import { wrapInList } from "prosemirror-schema-list";
import { TextSelection } from "prosemirror-state";
import { createUndoManager } from "articollab";
import { connectSync, createWebSocketTransport } from "articollab/sync";
import { selectionSchema } from "../../shared/presence.js";
import { createRichEditor } from "../editor.js";
import { editorSchema, Note } from "../schema.js";
import { startRichEditorServer } from "../server.ts";

// A DOM for the editors; prosemirror-view reads it when editor.js first loads it.
const window = new Window();
Object.assign(globalThis, { window, document: window.document });

/** Waits for `condition` with real timers: writers synchronize on their own. */
async function until(condition: () => boolean, what: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function host(t: TestContext) {
  const started = await startRichEditorServer();
  const cleanups: (() => void)[] = [];
  t.after(async () => { for (const cleanup of cleanups) cleanup(); await started.close(); });
  async function writer() {
    const sync = await connectSync(Note, { pollInterval: 0, presence: { schema: selectionSchema },
      transport: createWebSocketTransport({ url: started.url.replace("http:", "ws:") + "/sync/socket" }) });
    const history = createUndoManager(sync.doc);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- happy-dom implements the DOM's HTMLElement.
    const editor = await createRichEditor(window.document.createElement("div") as unknown as HTMLElement, sync.doc, {
      label: "Writer text", history, canEdit: () => true, onError(error) { throw error; },
      onChange() {}, onCommand() {}, onUnsentComposition() {},
    });
    editor.setReadOnly(false);
    cleanups.push(() => { editor.destroy(); history.destroy(); sync.close(); });
    const view = editor.view;
    return { sync, view, run: (command: import("prosemirror-state").Command) => command(view.state, (tr) => { view.dispatch(tr); }) };
  }
  return { url: started.url, writer };
}

describe("Rich text example host", () => {
  it("serves the page and every module its import map names, and nothing else", async (t) => {
    const { url } = await host(t);
    const html = await (await fetch(url)).text();
    assert.equal(html, readFileSync(new URL("../index.html", import.meta.url), "utf8"));
    const match = /<script type="importmap">\s*([\s\S]*?)\s*<\/script>/.exec(html);
    assert.ok(match);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This example's fixed import map; every target is fetched below.
    const map = JSON.parse(match[1]!) as { imports: Record<string, string> };
    for (const route of [...Object.values(map.imports), "/dist/sync/index.js", "/dist/prosemirror/sync.js", "/rich-editor/page.js",
      "/rich-editor/editor.js", "/rich-editor/schema.js", "/shared/sync-ui.js", "/shared/presence.js"]) {
      const asset = await fetch(url + route);
      assert.equal(asset.status, 200, route);
      assert.equal(asset.headers.get("Content-Type"), "text/javascript; charset=utf-8");
      assert.ok((await asset.text()).length > 0);
    }
    for (const route of ["/server.ts", "/package.json", "/rich-editor/server.ts", "/rich-editor/binding.js",
      "/node_modules/prosemirror-model/dist/index.js"]) {
      const asset = await fetch(url + route); assert.equal(asset.status, 404, route); await asset.text();
    }
  });

  it("keeps two writers' editors identical over WebSockets, and drops unsafe links", async (t) => {
    const { writer } = await host(t);
    const a = await writer(), b = await writer();
    a.view.dispatch(a.view.state.tr.insertText("Shopping"));
    a.run(wrapInList(editorSchema.nodes.bullet_list!));
    await until(() => b.view.state.doc.firstChild?.type.name === "bullet_list" &&
      b.sync.doc.state.body.toString() === "Shopping", "B to see A's list");
    b.view.dispatch(b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc, 3, 11)));
    b.run(toggleMark(editorSchema.marks.link!, { href: "javascript:alert(1)" }));
    b.run(toggleMark(editorSchema.marks.strong!));
    await until(() => JSON.stringify(a.view.state.doc.toJSON()) === JSON.stringify(b.view.state.doc.toJSON()) &&
      a.view.state.doc.rangeHasMark(3, 11, editorSchema.marks.strong!), "both to converge");
    assert.equal(b.view.state.doc.rangeHasMark(3, 11, editorSchema.marks.link!), false);
    assert.deepEqual(a.sync.doc.state.body.blocks().map(({ attributes }) => attributes), [{ list: "bullet" }]);
  });

  it("imports without DOM, fetch or listening side effects", async () => {
    const modules = ["server.ts", "page.js", "editor.js", "schema.js"];
    const script = `
      const { Server } = await import("node:http");
      Server.prototype.listen = () => { throw new Error("Unexpected listen"); };
      globalThis.fetch = () => { throw new Error("Unexpected fetch"); };
      Object.defineProperty(globalThis, "document", { get() { throw new Error("Unexpected DOM access"); } });
      for (const url of ${JSON.stringify(modules.map((name) => new URL("../" + name, import.meta.url).href))}) await import(url);
    `;
    await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script]);
  });
});
