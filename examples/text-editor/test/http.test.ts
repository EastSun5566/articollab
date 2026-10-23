import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { type EditorState, type TransactionSpec } from "@codemirror/state";
import { createServer } from "../../../src/index.ts";
import { Board } from "../../resume.ts";
import { connectBrowserHttpClient } from "../../browser-http-smoke/smoke.js";
import { createTextBinding } from "../binding.js";
import { createEditorActions } from "../actions.js";
import { startTextEditorServer } from "../server.ts";

async function fixture(t: TestContext, server = createServer(Board), fetcher = fetch) {
  const host = await startTextEditorServer(server);
  const bindings: ReturnType<typeof createTextBinding>[] = [];
  t.after(async () => { for (const binding of bindings) binding.destroy(); await host.close(); });
  async function connect() {
    const connection = await connectBrowserHttpClient(host.url, { fetch: fetcher });
    let rendered: EditorState | undefined;
    let readOnly = false;
    const errors: unknown[] = [];
    const binding = createTextBinding(connection.doc, {
      update(transactions) {
        for (const transaction of transactions) { assert.equal(transaction.startState, rendered); rendered = transaction.state; }
      },
      canEdit: () => !readOnly,
      onError(error) { errors.push(error); },
    });
    rendered = binding.state;
    bindings.push(binding);
    return { connection, binding, errors,
      edit(spec: TransactionSpec) { binding.dispatch([binding.state.update(spec)]); },
      check() {
        assert.equal(rendered, binding.state);
        assert.equal(rendered.doc.toString(), connection.doc.state.body.toString());
        assert.deepEqual(binding.elements, Array.from(connection.doc.state.body));
      },
      setReadOnly(next: boolean) { readOnly = next; },
    };
  }
  return { host, server, connect };
}

describe("Text editor HTTP prototype", { timeout: 30_000 }, () => {
  for (const samePath of [false, true]) {
    it(`converges real HTTP edits with ${samePath ? "same" : "disjoint"}-path pending without observer echo`, async (t) => {
      const f = await fixture(t), a = await f.connect(), b = await f.connect();
      a.edit({ changes: { from: 0, insert: "Hello😀\r\n" } });
      if (samePath) b.edit({ changes: { from: 0, insert: "中文" } });
      else b.connection.doc.state.count.value = 7;
      assert.equal(f.server.snapshot().serverSeq, 0);
      assert.equal(await a.connection.sync(), true); a.check(); b.check();
      assert.equal(await b.connection.sync(), true); a.check(); b.check();
      assert.equal(await a.connection.sync(), true); a.check(); b.check();
      assert.equal(a.binding.state.doc.toString(), b.binding.state.doc.toString());
      assert.equal(f.server.snapshot().serverSeq, 2);
      assert.equal(a.connection.doc.checkpoint().lastLocalSeq, 1);
      assert.equal(b.connection.doc.checkpoint().lastLocalSeq, 1);
      assert.deepEqual(a.connection.doc.checkpoint().pendingBatches, []);
      assert.deepEqual(b.connection.doc.checkpoint().pendingBatches, []);
    });
  }

  it("adopts authoritative transformations and confirms dependent pending with no extra batches", async (t) => {
    const server = createServer(Board, { resolve: ({ batch }) => batch.operations.map((operation) =>
      operation.type === "text/insert" ? { ...operation, value: operation.value.replaceAll("x", "X") } : operation) });
    const f = await fixture(t, server), a = await f.connect(), b = await f.connect();
    a.edit({ changes: { from: 0, insert: "xx😀" } });
    a.edit({ changes: { from: 4, insert: "tail" } });
    assert.equal(await a.connection.sync(), true);
    assert.equal(await b.connection.sync(), true);
    a.check(); b.check();
    assert.equal(a.binding.state.doc.toString(), "XX😀tail");
    assert.equal(server.snapshot().serverSeq, 2);
    assert.equal(a.connection.doc.checkpoint().lastLocalSeq, 2);
  });

  it("clears rejected insertion content, preserves blocked work and resumes after cancellation", async (t) => {
    const server = createServer(Board, { resolve: ({ batch }) => batch.operations.some((operation) =>
      operation.type === "text/insert" && operation.value === "discard") ? [] : batch.operations });
    const f = await fixture(t, server), a = await f.connect(), b = await f.connect();
    a.edit({ changes: { from: 0, insert: "discard" } });
    a.edit({ changes: { from: 7, insert: "!" } });
    assert.equal(await a.connection.sync(), false);
    a.check();
    assert.equal(a.binding.state.doc.toString(), "");
    assert.equal(a.connection.doc.replayConflict?.batch.seq, 2);
    assert.deepEqual(a.connection.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [2]);
    assert.throws(() => a.edit({ changes: { from: 0, insert: "not yet" } }));
    assert.equal(await a.connection.rejectPending(), true);
    a.edit({ changes: { from: 0, insert: "ok😀" } });
    assert.equal(await a.connection.sync() && await b.connection.sync(), true);
    a.check(); b.check();
    assert.equal(b.binding.state.doc.toString(), "ok😀");
    assert.equal(a.connection.doc.checkpoint().lastLocalSeq, 3);
    assert.deepEqual(a.errors, []);
  });

  it("preserves pending and the editor when retained history cannot fill a gap", async (t) => {
    const f = await fixture(t, createServer(Board, { historyLimit: 0 }));
    const a = await f.connect(), b = await f.connect();
    a.edit({ changes: { from: 0, insert: "unsent" } });
    b.edit({ changes: { from: 0, insert: "remote" } });
    assert.equal(await b.connection.sync(), false); // POST accepted, but its own catch-up is unavailable.
    const saved = a.connection.doc.checkpoint();
    assert.equal(await a.connection.sync(), false);
    assert.equal(await a.connection.rejectPending(), false);
    assert.deepEqual(a.connection.doc.checkpoint(), saved);
    assert.equal(f.server.snapshot().serverSeq, 1);
    a.check();
  });

  it("stops after a lost POST response and keeps the accepted result and local pending", async (t) => {
    const failure = new Error("lost response");
    let submissions = 0;
    const f = await fixture(t, createServer(Board), async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(input instanceof Request ? input.url : input.toString()).pathname === "/batches") {
        submissions++; await response.text(); throw failure;
      }
      return response;
    });
    const a = await f.connect();
    a.edit({ changes: { from: 0, insert: "kept" } });
    await assert.rejects(a.connection.sync(), (error) => error === failure);
    await assert.rejects(a.connection.rejectPending(), (error) => error === failure);
    assert.equal(submissions, 1);
    assert.equal(f.server.snapshot().data.body.value, "kept");
    assert.equal(a.connection.doc.checkpoint().pendingBatches.length, 1);
    a.check();
  });

  it("keeps a listener failure, the completed checkpoint and the page-wide stop", async (t) => {
    const failure = new Error("listener stopped delivery");
    const server = createServer(Board, { resolve: ({ batch }) => batch.operations.map((operation) =>
      operation.type === "text/insert" ? { ...operation, value: operation.value.toUpperCase() } : operation) });
    const f = await fixture(t, server), a = await f.connect();
    a.edit({ changes: { from: 0, insert: "x" } });
    const unsubscribe = a.connection.doc.on("change", (event) => { if (event.origin === "server") throw failure; });
    t.after(unsubscribe);
    const actions = createEditorActions([{ sync: a.connection.sync, rejectPending: a.connection.rejectPending,
      isComposing: () => false, isBlocked: () => a.connection.doc.replayConflict !== null,
      setReadOnly: (next) => a.setReadOnly(next),
    }]);
    await assert.rejects(actions.run(0, "sync"), (error) => error === failure);
    assert.equal(actions.failed, true);
    assert.equal(a.connection.doc.checkpoint().snapshot.serverSeq, 1);
    assert.deepEqual(a.connection.doc.checkpoint().pendingBatches, []);
    assert.equal(a.connection.doc.state.body.toString(), "X");
    assert.equal(a.binding.state.doc.toString(), "x"); // Existing listener failed before observers ran.
    await assert.rejects(actions.run(0, "sync"), (error) => error === failure);
    assert.throws(() => a.edit({ changes: { from: 0, insert: "more" } }));
  });

  it("serves fixed ESM assets, blocks source/tooling routes and closes idempotently", async (t) => {
    const f = await fixture(t);
    const response = await fetch(f.host.url);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(html, readFileSync(new URL("../index.html", import.meta.url), "utf8"));
    const match = html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/);
    assert.ok(match);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Parses this example's fixed import map, which is independently checked by fetching every target.
    const map = JSON.parse(match[1]!) as { imports: Record<string, string> };
    for (const route of [...Object.values(map.imports), "/text-editor/page.js", "/text-editor/editor.js",
      "/text-editor/binding.js", "/text-editor/changes.js", "/text-editor/actions.js", "/browser-http-smoke/smoke.js", "/http-sync-controller.js"]) {
      const asset = await fetch(f.host.url + route);
      assert.equal(asset.status, 200, route);
      assert.equal(asset.headers.get("Content-Type"), "text/javascript; charset=utf-8");
      assert.equal(asset.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(asset.headers.get("Cache-Control"), "no-store");
      assert.ok((await asset.text()).length > 0);
    }
    for (const route of ["/src/index.ts", "/server.ts", "/package.json", "/pnpm-lock.yaml", "/node_modules/@codemirror/view/dist/index.js", "/dist/index.js.map", "/dist/index.d.ts"]) {
      const asset = await fetch(f.host.url + route); assert.equal(asset.status, 404); await asset.text();
    }
    const wrong = await fetch(f.host.url + "/text-editor/binding.js", { method: "POST", body: "ignored" });
    assert.equal(wrong.status, 405); await wrong.text();
    await f.host.close(); await f.host.close();
  });

  it("imports without DOM, fetch, registration or listening side effects", async () => {
    const modules = ["server.ts", "page.js", "editor.js", "binding.js", "changes.js", "actions.js"];
    const script = `
      const { Server } = await import("node:http");
      Server.prototype.listen = () => { throw new Error("Unexpected listen"); };
      globalThis.fetch = () => { throw new Error("Unexpected fetch"); };
      Object.defineProperty(globalThis, "document", { get() { throw new Error("Unexpected DOM access"); } });
      for (const url of ${JSON.stringify(modules.map((name) => new URL("../" + name, import.meta.url).href))}) await import(url);
    `;
    const result = await promisify(execFile)(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", script], { timeout: 10_000 });
    assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  });
});
