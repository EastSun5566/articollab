import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Window } from "happy-dom";
import { createServer } from "articollab";
import { keepSafeLinks, Note } from "../schema.js";
import { startTiptapServer } from "../server.ts";

// A DOM for React, Tiptap and ProseMirror, and the flag that lets act() flush updates.
const window = new Window();
Object.assign(globalThis, { window, document: window.document, KeyboardEvent: window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window) });
const { act } = await import("react");
const { mountEditors } = await import("../page.js");
// happy-dom's classes, typed as the DOM's: the page only sees the DOM's.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- happy-dom implements these DOM classes.
const dom = window as unknown as { HTMLElement: typeof HTMLElement; HTMLSelectElement: typeof HTMLSelectElement; Event: typeof Event };

type Editor = import("@tiptap/core").Editor;

/** Waits for `condition`, letting React and the network run in between. */
async function until(condition: () => boolean, what: string, detail?: () => string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}${detail === undefined ? "" : ": " + detail()}`);
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

/** The page with both writers, served by a fresh host. */
async function page(t: TestContext) {
  const server = createServer(Note, { resolve: keepSafeLinks });
  const host = await startTiptapServer(server);
  const root = document.createElement("div");
  document.body.append(root);
  const mounted = await act(() => mountEditors(root, host.url));
  t.after(async () => { act(() => { mounted.destroy(); }); root.remove(); await host.close(); });
  const pane = (label: string) => {
    const element = root.querySelector(`[aria-label="${label}"]`);
    assert.ok(element !== null, label);
    return element;
  };
  /** The Tiptap editor a pane shows: Tiptap keeps it on the editor's element. */
  const editor = (label: string): Editor => {
    const element = pane(label).querySelector<HTMLElement & { editor?: Editor }>(".ProseMirror");
    assert.ok(element?.editor !== undefined, label + " editor");
    return element.editor;
  };
  const button = (label: string, name: string) => {
    const found = [...pane(label).querySelectorAll("button")].find((element) => element.textContent === name);
    assert.ok(found instanceof dom.HTMLElement, name);
    return found;
  };
  const html = (label: string) => editor(label).getHTML();
  return { server, mounted, pane, editor, button, html };
}

describe("Tiptap React example", { timeout: 30_000 }, () => {
  it("serves the page and its own modules, and nothing else", async (t) => {
    const host = await startTiptapServer();
    t.after(() => host.close());
    const html = await (await fetch(host.url)).text();
    assert.equal(html, readFileSync(new URL("../index.html", import.meta.url), "utf8"));
    const match = /<script type="importmap">\s*([\s\S]*?)\s*<\/script>/.exec(html);
    assert.ok(match);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This example's fixed import map.
    const map = JSON.parse(match[1]!) as { imports: Record<string, string> };
    const local = Object.values(map.imports).filter((target) => target.startsWith("/"));
    for (const route of [...local, "/tiptap-react/page.js", "/tiptap-react/app.js", "/tiptap-react/schema.js", "/shared/sync-ui.js",
      "/shared/presence.js", "/dist/prosemirror/sync.js"]) {
      const asset = await fetch(host.url + route);
      assert.equal(asset.status, 200, route);
      assert.equal(asset.headers.get("Content-Type"), "text/javascript; charset=utf-8");
      await asset.text();
    }
    // React, Tiptap and ProseMirror come from one CDN, pinned, so the page loads one ProseMirror.
    for (const [name, target] of Object.entries(map.imports)) {
      if (!target.startsWith("/")) assert.match(target, /^https:\/\/esm\.sh\/(@[a-z]+\/)?[a-z-]+@\d+\.\d+\.\d+/, name);
    }
    for (const route of ["/server.ts", "/package.json", "/tiptap-react/server.ts", "/node_modules/@tiptap/core/dist/index.js"]) {
      const asset = await fetch(host.url + route); assert.equal(asset.status, 404, route); await asset.text();
    }
  });

  it("keeps two writers' editors identical over WebSockets, drops unsafe links, and undoes this writer's edits", async (t) => {
    const { server, editor, button, html, pane } = await page(t);
    const a = () => editor("Writer A"), b = () => editor("Writer B");
    await until(() => pane("Writer A").querySelector(".badge")?.textContent === "Live" &&
      pane("Writer B").querySelector(".badge")?.textContent === "Live", "both writers to connect");
    act(() => { a().commands.insertContent("Shopping"); });
    act(() => { a().commands.selectAll(); });
    act(() => { button("Writer A", "B").click(); });
    act(() => { a().commands.setTextSelection(a().state.doc.content.size); });
    act(() => { a().commands.enter(); a().commands.insertContent("milk"); });
    act(() => { button("Writer A", "• List").click(); });
    await until(() => html("Writer B") === html("Writer A") && html("Writer B").includes("<ul>"), "B to see A's list", () => html("Writer A") + " / " + html("Writer B"));
    assert.equal(html("Writer B"), "<p><strong>Shopping</strong></p><ul><li><p>milk</p></li></ul>");

    // A code block with a language, from B.
    act(() => { b().commands.setTextSelection(b().state.doc.content.size); b().commands.enter(); });
    act(() => { b().commands.liftListItem("listItem"); b().commands.insertContent("let x = 1;"); });
    const language = pane("Writer B").querySelector(".language");
    assert.ok(language instanceof dom.HTMLSelectElement);
    act(() => {
      Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")?.set?.call(language, "js");
      language.dispatchEvent(new dom.Event("change", { bubbles: true }));
    });
    await until(() => html("Writer A").includes('<pre><code class="language-js">let x = 1;</code></pre>'), "A to see B's code block");

    // Tiptap's setLink refuses an unsafe address, but any writer can send one: it disappears once the server drops it.
    act(() => { b().commands.setTextSelection({ from: 1, to: 9 }); });
    assert.equal(b().commands.setLink({ href: "javascript:alert(1)" }), false);
    act(() => { b().commands.setMark("link", { href: "javascript:alert(1)" }); });
    assert.ok(html("Writer B").includes("<a "));
    await until(() => !html("Writer B").includes("<a ") && html("Writer A") === html("Writer B"), "the link to go");

    // Undo takes back only A's last edit; B's code block stays.
    const undo = button("Writer A", "Undo");
    assert.equal(undo.hasAttribute("disabled"), false);
    let milk = 0;
    a().state.doc.descendants((node, position) => { if (node.text === "milk") milk = position + node.nodeSize; });
    act(() => { a().commands.setTextSelection(milk); a().commands.insertContent("!"); });
    await until(() => html("Writer B").includes("milk!"), "B to see the exclamation mark");
    await new Promise((resolve) => setTimeout(resolve, 600)); // Past captureTimeout: "!" is its own step.
    act(() => { undo.click(); });
    await until(() => !html("Writer B").includes("milk!") && html("Writer A") === html("Writer B"), "the undo to reach B");
    assert.ok(html("Writer A").includes("language-js"));
    assert.ok((server.commitsSince(0) ?? []).length > 0);
  });

  it("imports its host and page without DOM, fetch or listening side effects", async () => {
    const modules = ["server.ts", "page.js", "schema.js"];
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
