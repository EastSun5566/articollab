import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { createServer } from "../../../src/index.ts";
import { connectSync, createHttpTransport } from "../../../src/sync/index.ts";
import { Board } from "../../resume.ts";
import { createTextBinding, remoteRanges } from "../binding.js";
import { createOfflineSwitch, describeSync } from "../../sync-ui.js";
import { createPresenceChannel } from "../presence.js";
import { startTextEditorServer } from "../server.ts";

/** Waits for `condition` with real timers: writers synchronize on their own. */
async function until(condition: () => boolean, what: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t: TestContext, server = createServer(Board)) {
  const host = await startTextEditorServer(server);
  const cleanups: (() => void)[] = [];
  t.after(async () => { for (const cleanup of cleanups) cleanup(); await host.close(); });
  async function connect(options: { fetch?: typeof fetch } = {}) {
    const network = createOfflineSwitch(options.fetch);
    const sync = await connectSync(Board, { pollInterval: 0, retry: { initialDelay: 20, maxDelay: 100 },
      transport: createHttpTransport({ url: host.url + "/sync/", fetch: network.fetch }) });
    let rendered: EditorState | undefined;
    const errors: unknown[] = [];
    const binding = createTextBinding(sync.doc, {
      update(transactions) {
        for (const transaction of transactions) { assert.equal(transaction.startState, rendered); rendered = transaction.state; }
      },
      canEdit: () => sync.status !== "failed" && sync.status !== "gap",
      onError(error) { errors.push(error); },
    });
    rendered = binding.state;
    cleanups.push(() => { binding.destroy(); sync.stop(); });
    await sync.sync().catch(() => {}); // The first pass opens the push channel.
    return { sync, network, binding, errors,
      text: () => binding.state.doc.toString(),
      pending: () => sync.doc.checkpoint().pendingBatches.length,
      edit(spec: TransactionSpec) { binding.dispatch([binding.state.update(spec)]); },
      check() {
        assert.equal(rendered, binding.state);
        assert.equal(rendered.doc.toString(), sync.doc.state.body.toString());
        assert.deepEqual(binding.elements, Array.from(sync.doc.state.body));
      },
    };
  }
  return { host, server, connect };
}

describe("Text editor on the sync adapter", { timeout: 30_000 }, () => {
  for (const samePath of [false, true]) {
    it(`converges ${samePath ? "same" : "disjoint"}-path edits automatically, without observer echo`, async (t) => {
      const f = await fixture(t), a = await f.connect(), b = await f.connect();
      await until(() => a.sync.push === "open" && b.sync.push === "open", "both push channels");
      a.edit({ changes: { from: 0, insert: "Hello😀\r\n" } });
      if (samePath) b.edit({ changes: { from: 0, insert: "中文" } });
      else b.sync.doc.state.count.value = 7;
      // Nobody calls sync(): local edits are sent and remote commits are pushed.
      await until(() => f.server.snapshot().serverSeq === 2 && a.pending() === 0 && b.pending() === 0 &&
        a.sync.doc.checkpoint().snapshot.serverSeq === 2 && b.sync.doc.checkpoint().snapshot.serverSeq === 2, "convergence");
      a.check(); b.check();
      assert.equal(a.text(), b.text());
      assert.equal(a.sync.doc.checkpoint().lastLocalSeq, 1, "receiving did not send anything back");
      assert.equal(b.sync.doc.checkpoint().lastLocalSeq, 1);
    });
  }

  it("adopts authoritative transformations with no extra batches", async (t) => {
    const server = createServer(Board, { resolve: ({ batch }) => batch.operations.map((operation) =>
      operation.type === "text/insert" ? { ...operation, value: operation.value.replaceAll("x", "X") } : operation) });
    const f = await fixture(t, server), a = await f.connect(), b = await f.connect();
    a.edit({ changes: { from: 0, insert: "xx😀" } });
    a.edit({ changes: { from: 4, insert: "tail" } });
    await until(() => a.text() === "XX😀tail" && b.text() === "XX😀tail" && a.pending() === 0, "the transformed text");
    a.check(); b.check();
    assert.equal(server.snapshot().serverSeq, 2);
    assert.equal(a.sync.doc.checkpoint().lastLocalSeq, 2);
  });

  it("blocks dependent work after a rejection, then resumes once it is discarded", async (t) => {
    const server = createServer(Board, { resolve: ({ batch }) => batch.operations.some((operation) =>
      operation.type === "text/insert" && operation.value === "discard") ? [] : batch.operations });
    const f = await fixture(t, server), a = await f.connect(), b = await f.connect();
    a.edit({ changes: { from: 0, insert: "discard" } });
    a.edit({ changes: { from: 7, insert: "!" } });
    await until(() => a.sync.status === "blocked", "the blocked status");
    a.check();
    assert.equal(a.text(), "");
    assert.equal(a.sync.doc.replayConflict?.batch.seq, 2);
    assert.deepEqual(describeSync(a.sync.status, a.sync.push, false).state, "blocked");
    assert.throws(() => a.edit({ changes: { from: 0, insert: "not yet" } }));
    assert.equal(await a.sync.rejectPending(), true);
    a.edit({ changes: { from: 0, insert: "ok😀" } });
    await until(() => b.text() === "ok😀" && a.pending() === 0, "the edit after discarding");
    a.check(); b.check();
    assert.equal(a.sync.doc.checkpoint().lastLocalSeq, 3);
    assert.deepEqual(a.errors, []);
  });

  it("keeps pending work and the editor when history cannot fill a gap", async (t) => {
    const f = await fixture(t, createServer(Board, { historyLimit: 0 }));
    const a = await f.connect(), b = await f.connect();
    a.network.set(true);
    a.edit({ changes: { from: 0, insert: "unsent" } });
    b.edit({ changes: { from: 0, insert: "remote" } });
    await until(() => f.server.snapshot().serverSeq === 1, "the remote commit");
    a.network.set(false);
    await a.sync.sync();
    assert.equal(a.sync.status, "gap");
    assert.equal(describeSync(a.sync.status, a.sync.push, false).state, "failed");
    assert.equal(a.pending(), 1, "pending work is kept, never replaced by a snapshot");
    assert.equal(a.text(), "unsent");
    a.check();
  });

  it("acknowledges a submission whose response was lost instead of sending it twice", async (t) => {
    let submissions = 0, lose = true;
    const lossy: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if ((input instanceof Request ? input.url : input.toString()).endsWith("/sync/batches")) {
        submissions++;
        if (lose) { lose = false; await response.text(); throw new Error("lost response"); }
      }
      return response;
    };
    const f = await fixture(t), a = await f.connect({ fetch: lossy });
    a.edit({ changes: { from: 0, insert: "kept" } });
    await until(() => a.pending() === 0, "the acknowledgement");
    assert.equal(submissions, 1, "catch-up found the accepted batch; nothing was resent");
    assert.equal(f.server.snapshot().data.body.value, "kept");
    a.check();
  });

  it("keeps editing offline and sends the work when the writer comes back", async (t) => {
    const f = await fixture(t), a = await f.connect(), b = await f.connect();
    await until(() => a.sync.push === "open", "A's push channel");
    a.network.set(true);
    await until(() => a.sync.push !== "open", "the channel to drop");
    a.edit({ changes: { from: 0, insert: "written offline" } });
    await until(() => a.sync.status === "retrying", "the retrying status");
    assert.equal(describeSync(a.sync.status, a.sync.push, true).text, "Offline");
    assert.equal(a.pending(), 1);
    assert.equal(b.text(), "");
    a.network.set(false);
    assert.equal(await a.sync.sync(), true);
    await until(() => b.text() === "written offline", "B to receive the offline edit");
    await until(() => a.sync.push === "open", "A to reconnect its push channel");
    assert.equal(describeSync(a.sync.status, a.sync.push, false).text, "Live");
    a.check(); b.check();
  });

  it("fails the writer when a document listener throws, after applying the commit", async (t) => {
    const failure = new Error("listener stopped delivery");
    const server = createServer(Board, { resolve: ({ batch }) => batch.operations.map((operation) =>
      operation.type === "text/insert" ? { ...operation, value: operation.value.toUpperCase() } : operation) });
    const f = await fixture(t, server), a = await f.connect();
    a.sync.doc.on("change", (event) => { if (event.origin === "server") throw failure; });
    a.edit({ changes: { from: 0, insert: "x" } });
    await until(() => a.sync.status === "failed", "the failed status");
    assert.ok(a.sync.error instanceof Error && a.sync.error.cause === failure);
    assert.equal(a.sync.doc.checkpoint().snapshot.serverSeq, 1);
    assert.deepEqual(a.sync.doc.checkpoint().pendingBatches, []);
    assert.equal(a.sync.doc.state.body.toString(), "X");
    assert.equal(a.text(), "x", "the listener failed before observers ran");
    assert.throws(() => a.edit({ changes: { from: 0, insert: "more" } }));
  });

  it("relays cursor presence that outruns commits, then resolves it once the text arrives", async (t) => {
    const f = await fixture(t), a = await f.connect(), b = await f.connect();
    const channel = (writer: typeof a) => createPresenceChannel({ url: f.host.url, clientId: writer.sync.doc.checkpoint().clientId });
    const presenceA = channel(a), presenceB = channel(b);
    async function showB(): Promise<unknown> {
      const entries = await presenceA.poll();
      return a.binding.setRemote(entries.flatMap(({ selection }) => selection === null ? [] : [{ label: "B", selection }]));
    }
    const shown = () => a.binding.state.field(remoteRanges).map(({ from, to }) => a.binding.state.doc.sliceString(from, to) + "@" + to);
    a.edit({ changes: { from: 0, insert: "Hello 😀 world" } });
    await until(() => b.text() === "Hello 😀 world", "B to receive the text");

    b.edit({ selection: EditorSelection.range(9, 14) });
    await presenceB.publish(b.binding.selectionCursors());
    assert.deepEqual(await showB(), [{ label: "B", resolved: true, from: 8, to: 13 }]);
    assert.deepEqual(shown(), ["world@14"]);

    b.network.set(true); // Keep B's next edit unsent while its presence, on its own channel, is shared.
    b.edit({ changes: { from: 14, insert: "!!" }, selection: EditorSelection.cursor(16) });
    await presenceB.publish(b.binding.selectionCursors());
    assert.deepEqual(await showB(), [{ label: "B", resolved: false }], "B's caret is in text A has not received");
    assert.deepEqual(shown(), []);
    b.network.set(false);
    await b.sync.sync();
    await until(() => shown().length === 1, "the caret to resolve");
    assert.deepEqual(shown(), ["@16"], "receiving the commit re-resolves the caret without another poll");
    a.check(); b.check();
    assert.deepEqual([a.errors, b.errors], [[], []]);
  });

  it("serves fixed ESM assets and the sync routes, blocks source/tooling routes and closes idempotently", async (t) => {
    const f = await fixture(t);
    const response = await fetch(f.host.url);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(html, readFileSync(new URL("../index.html", import.meta.url), "utf8"));
    const match = html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/);
    assert.ok(match);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Parses this example's fixed import map, which is independently checked by fetching every target.
    const map = JSON.parse(match[1]!) as { imports: Record<string, string> };
    for (const route of [...Object.values(map.imports), "/dist/sync/index.js", "/text-editor/page.js", "/text-editor/editor.js",
      "/text-editor/binding.js", "/text-editor/changes.js", "/text-editor/presence.js",
      "/browser-http-smoke/smoke.js", "/http-sync-controller.js", "/sync-ui.js"]) {
      const asset = await fetch(f.host.url + route);
      assert.equal(asset.status, 200, route);
      assert.equal(asset.headers.get("Content-Type"), "text/javascript; charset=utf-8");
      assert.equal(asset.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(asset.headers.get("Cache-Control"), "no-store");
      assert.ok((await asset.text()).length > 0);
    }
    for (const route of ["/src/index.ts", "/server.ts", "/presence-relay.ts", "/text-editor/actions.js", "/package.json",
      "/pnpm-lock.yaml", "/node_modules/@codemirror/view/dist/index.js", "/dist/index.js.map", "/dist/index.d.ts", "/sync/unknown"]) {
      const asset = await fetch(f.host.url + route); assert.equal(asset.status, 404, route); await asset.text();
    }
    const commits = await fetch(f.host.url + "/sync/commits?since=0");
    assert.equal(commits.status, 200); assert.deepEqual(await commits.json(), []);
    const wrong = await fetch(f.host.url + "/text-editor/binding.js", { method: "POST", body: "ignored" });
    assert.equal(wrong.status, 405); await wrong.text();
    await f.host.close(); await f.host.close();
  });

  it("imports without DOM, fetch, registration or listening side effects", async () => {
    const modules = ["server.ts", "page.js", "editor.js", "binding.js", "changes.js", "presence.js"];
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
