import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Window } from "happy-dom";
import { act } from "react";
import { createServer } from "articollab";
import { mountTodos } from "../page.js";
import { Todos } from "../schema.js";
import { startTodoServer } from "../server.ts";

// A DOM for react-dom, and the flag that lets act() flush updates.
const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom's classes, typed as the DOM's: the page only sees the DOM's.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- happy-dom implements these DOM classes.
const dom = window as unknown as { Event: typeof Event; FocusEvent: typeof FocusEvent; HTMLInputElement: typeof HTMLInputElement; HTMLElement: typeof HTMLElement };

/** Types into an input the way a browser does, so React sees the change. */
function type(input: Element | null | undefined, value: string) {
  assert.ok(input instanceof dom.HTMLInputElement);
  act(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
}

function click(element: Element | null | undefined) {
  assert.ok(element instanceof dom.HTMLElement);
  act(() => { element.click(); });
}

/** Waits for `condition`, letting React and the network run in between. */
async function until(condition: () => boolean, what: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

/** The page with both writers, served by a fresh host. */
async function page(t: TestContext) {
  const server = createServer(Todos);
  const host = await startTodoServer(server);
  const root = document.createElement("div");
  document.body.append(root);
  const mounted = await act(() => mountTodos(root, host.url));
  t.after(async () => { act(() => { mounted.destroy(); }); root.remove(); await host.close(); });
  const panes = () => [...root.querySelectorAll(".writer")];
  const pane = (index: number) => {
    const element = panes()[index];
    assert.ok(element !== undefined);
    return element;
  };
  const titles = (index: number) => [...pane(index).querySelectorAll<HTMLInputElement>(".item .title")].map((input) => input.value);
  const likes = (index: number) => pane(index).querySelector(".like")?.textContent;
  function add(index: number, title: string) {
    type(pane(index).querySelector(".add input"), title);
    const form = pane(index).querySelector(".add");
    assert.ok(form !== null);
    act(() => { form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true })); });
  }
  const button = (index: number, name: string) =>
    [...pane(index).querySelectorAll("button")].find((element) => element.textContent === name || element.getAttribute("aria-label") === name);
  const offline = (index: number) => [...pane(index).querySelectorAll(".controls input")].at(-1);
  return { server, pane, titles, likes, add, button, offline };
}

describe("React todo example", { timeout: 30_000 }, () => {
  it("serves the page and every local module it imports, and nothing else", async (t) => {
    const host = await startTodoServer();
    t.after(() => host.close());
    const html = await (await fetch(host.url)).text();
    assert.equal(html, readFileSync(new URL("../index.html", import.meta.url), "utf8"));
    for (const route of ["/react-todo/page.js", "/react-todo/app.js", "/react-todo/schema.js", "/shared/sync-ui.js", "/dist/react.js",
      "/dist/sync/index.js", "/vendor/articulated/index.js"]) {
      const asset = await fetch(host.url + route);
      assert.equal(asset.status, 200, route);
      assert.equal(asset.headers.get("Content-Type"), "text/javascript; charset=utf-8");
      await asset.text();
    }
    for (const route of ["/server.ts", "/react-todo/server.ts", "/package.json"]) {
      const asset = await fetch(host.url + route);
      assert.equal(asset.status, 404, route);
      await asset.text();
    }
  });

  it("keeps two writers' lists, likes and presence in step", async (t) => {
    const p = await page(t);
    await until(() => p.pane(1).querySelector(".badge")?.textContent === "Live", "B's push channel");
    p.add(0, "Milk");
    p.add(0, "Eggs");
    await until(() => p.titles(1).join() === "Milk,Eggs", "B to see A's items");
    click(p.pane(1).querySelector("input[type=checkbox]"));
    await until(() => p.pane(0).querySelector(".item.done") !== null, "A to see B tick Milk");
    assert.equal(p.pane(0).querySelector(".summary")?.textContent, "2 items, 1 left");

    // Both like at once: B offline, A online, then B back.
    click(p.offline(1));
    click(p.pane(1).querySelector(".like"));
    click(p.pane(0).querySelector(".like"));
    click(p.offline(1));
    await until(() => p.likes(0) === "👍 2" && p.likes(1) === "👍 2", "both likes to count");
    assert.equal(p.server.snapshot().data.likes, 2);

    // A edits Eggs: B shows who is editing it.
    const eggs = p.pane(0).querySelectorAll(".item .title")[1];
    act(() => { eggs?.dispatchEvent(new dom.FocusEvent("focusin", { bubbles: true })); });
    await until(() => p.pane(1).querySelector(".editing")?.textContent === "Writer A editing", "B to see A editing");
    act(() => { eggs?.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true })); });
    await until(() => p.pane(1).querySelector(".editing") === null, "the marker to go");
  });

  it("converges offline edits, and undoes only this writer's own last action", async (t) => {
    const p = await page(t);
    p.add(0, "Milk");
    p.add(0, "Eggs");
    await until(() => p.titles(1).join() === "Milk,Eggs", "B to see the items");
    click(p.offline(1));
    type(p.pane(1).querySelectorAll(".item .title")[1] ?? null, "Eggs (12)");
    click(p.button(0, "Delete Milk"));
    click(p.pane(0).querySelector(".like"));
    click(p.offline(1));
    await until(() => p.titles(0).join() === "Eggs (12)" && p.titles(1).join() === "Eggs (12)", "both to converge");

    // Quick button presses are separate steps: Undo takes back the like, then the deletion.
    click(p.button(0, "Undo"));
    await until(() => p.likes(1) === "👍 0", "the like to be undone");
    assert.equal(p.titles(0).join(), "Eggs (12)");
    click(p.button(0, "Undo"));
    await until(() => p.titles(1).join() === "Milk,Eggs (12)", "Milk to come back, B's rename kept");
    click(p.button(0, "Redo"));
    await until(() => p.titles(1).join() === "Eggs (12)", "redo");
  });

  it("imports without DOM, fetch or listening side effects", async () => {
    const modules = ["server.ts", "page.js", "app.js", "schema.js"];
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
