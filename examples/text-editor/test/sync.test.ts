import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { createServer, createUndoManager } from "../../../dist/index.js";
import { connectSync, createHttpTransport, createWebSocketTransport } from "../../../dist/sync/index.js";
import { Note } from "../schema.js";
import { createTextBinding, remoteRanges } from "../binding.js";
import { createOfflineSwitch, describeSync } from "../../shared/sync-ui.js";
import { selectionOf, selectionSchema } from "../../shared/presence.js";
import { startTextEditorServer } from "../server.ts";

/** Waits for `condition` with real timers: writers synchronize on their own. */
async function until(condition: () => boolean, what: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t: TestContext, server = createServer(Note), presenceTtl?: number) {
  const host = await startTextEditorServer(server, presenceTtl);
  const cleanups: (() => void)[] = [];
  t.after(async () => { for (const cleanup of cleanups) cleanup(); await host.close(); });
  /** A writer over WebSocket, as on the page, or over HTTP with `http` or a custom `fetch`. */
  async function connect(options: { http?: boolean; fetch?: typeof fetch; undo?: boolean } = {}) {
    const network = createOfflineSwitch(options.fetch);
    const transport = options.http === true || options.fetch !== undefined
      ? createHttpTransport({ url: host.url + "/sync/", fetch: network.fetch })
      : createWebSocketTransport({ url: host.url.replace("http:", "ws:") + "/sync/socket", WebSocket: network.WebSocket });
    const sync = await connectSync(Note, { pollInterval: 0, retry: { initialDelay: 20, maxDelay: 100 },
      presence: { schema: selectionSchema }, transport });
    let rendered: EditorState | undefined;
    const history = options.undo === true ? createUndoManager(sync.doc, { paths: ["body"] }) : undefined;
    const errors: unknown[] = [];
    const binding = createTextBinding(sync.doc, {
      update(transactions) {
        for (const transaction of transactions) { assert.equal(transaction.startState, rendered); rendered = transaction.state; }
      },
      canEdit: () => sync.status !== "failed" && sync.status !== "gap",
      onError(error) { errors.push(error); },
      onCompositionBoundary: () => { history?.stopCapturing(); },
    });
    rendered = binding.state;
    cleanups.push(() => { binding.destroy(); history?.destroy(); sync.close(); });
    await sync.sync().catch(() => {}); // The first pass opens the push channel.
    return { sync, network, binding, errors, history,
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
  it("sends one confirmed composition over WebSocket and undoes it without removing the peer edit", async (t) => {
    const f = await fixture(t), a = await f.connect({ undo: true }), b = await f.connect();
    assert.ok(a.history);
    await until(() => a.sync.push === "open" && b.sync.push === "open", "both push channels");
    a.edit({ changes: { from: 0, insert: "ABC" } });
    await until(() => b.text() === "ABC" && a.pending() === 0, "initial text");
    a.binding.startComposition();
    a.edit({ changes: { from: 0, to: 2, insert: "ㄏ" } });
    a.edit({ changes: { from: 1, insert: "ㄠ" } });
    b.edit({ changes: { from: 1, insert: "X" } });
    await until(() => a.sync.doc.state.body.toString() === "AXBC", "queued peer edit");
    assert.equal(a.text(), "ㄏㄠC");
    assert.equal(f.server.snapshot().serverSeq, 2);
    assert.equal(a.pending(), 0);
    a.edit({ changes: { from: 0, to: 2, insert: "好" } });
    a.binding.finishComposition();
    await until(() => b.text() === "好XC" && a.pending() === 0, "confirmed composition");
    a.check(); b.check();
    const commits = f.server.commitsSince(1);
    assert.ok(commits);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits.map(({ operations }) => operations.flatMap((op) =>
      op.type === "text/insert" ? [op.value] : [])), [["X"], ["好"]]);
    assert.equal(a.history.undo(), true);
    await until(() => a.pending() === 0 && b.text() === a.text(), "composition undo");
    assert.equal(a.text(), "AXBC", "only the composition was undone");
    a.check(); b.check();
  });

  it("keeps an offline composition local until confirmation, then sends it after reconnecting", async (t) => {
    const f = await fixture(t), a = await f.connect(), b = await f.connect();
    await until(() => a.sync.push === "open" && b.sync.push === "open", "both push channels");
    a.network.set(true);
    await until(() => a.sync.push !== "open", "A going offline");
    a.binding.startComposition();
    a.edit({ changes: { from: 0, insert: "ㄏㄠ" } });
    assert.equal(a.pending(), 0);
    a.edit({ changes: { from: 0, to: 2, insert: "好😀" } });
    a.binding.finishComposition();
    assert.equal(a.pending(), 1);
    assert.equal(f.server.snapshot().serverSeq, 0);
    await until(() => a.sync.status === "retrying", "A's offline submission failing");
    a.network.set(false);
    assert.equal(await a.sync.sync(), true);
    await until(() => b.text() === "好😀", "peer receiving the offline edit");
    assert.equal(f.server.snapshot().serverSeq, 1);
    assert.equal(a.pending(), 0);
    a.check(); b.check();
  });

  it("converges concurrent edits automatically, without observer echo", async (t) => {
    const f = await fixture(t), a = await f.connect(), b = await f.connect();
    await until(() => a.sync.push === "open" && b.sync.push === "open", "both push channels");
    a.edit({ changes: { from: 0, insert: "Hello😀\r\n" } });
    b.edit({ changes: { from: 0, insert: "中文" } });
    // Nobody calls sync(): local edits are sent and remote commits are pushed.
    await until(() => f.server.snapshot().serverSeq === 2 && a.pending() === 0 && b.pending() === 0 &&
      a.sync.doc.checkpoint().snapshot.serverSeq === 2 && b.sync.doc.checkpoint().snapshot.serverSeq === 2, "convergence");
    a.check(); b.check();
    assert.equal(a.text(), b.text());
    assert.equal(a.sync.doc.checkpoint().lastLocalSeq, 1, "receiving did not send anything back");
    assert.equal(b.sync.doc.checkpoint().lastLocalSeq, 1);
  });

  it("adopts authoritative transformations with no extra batches", async (t) => {
    const server = createServer(Note, { resolve: ({ batch }) => batch.operations.map((operation) =>
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
    const server = createServer(Note, { resolve: ({ batch }) => batch.operations.some((operation) =>
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
    const f = await fixture(t, createServer(Note, { maxHistory: 0 }));
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
    const server = createServer(Note, { resolve: ({ batch }) => batch.operations.map((operation) =>
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

  it("shares cursor presence that outruns commits, then resolves it once the text arrives", async (t) => {
    const f = await fixture(t), a = await f.connect();
    // B's batches can be held back while its presence and push channel keep working.
    let holdBatches = false;
    const b = await f.connect({ fetch: (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return holdBatches && url.endsWith("/batches") ? Promise.reject(new TypeError("batch held")) : fetch(input, init);
    } });
    await until(() => a.sync.push === "open" && b.sync.push === "open", "both push channels");
    const showB = () => a.binding.setRemote([...a.sync.presence.peers.values()].flatMap((state) => {
      const selection = selectionOf(state);
      return selection === null ? [] : [{ label: "B", selection }];
    }));
    const shown = () => a.binding.state.field(remoteRanges).map(({ from, to }) => a.binding.state.doc.sliceString(from, to) + "@" + to);
    const peerSelection = () => JSON.stringify([...a.sync.presence.peers.values()].map(selectionOf));
    a.edit({ changes: { from: 0, insert: "Hello 😀 world" } });
    await until(() => b.text() === "Hello 😀 world", "B to receive the text");

    b.edit({ selection: EditorSelection.range(9, 14) });
    b.sync.presence.set({ selection: b.binding.selectionCursors() });
    await until(() => a.sync.presence.peers.size === 1, "A to receive B's selection over the push channel");
    assert.deepEqual(showB(), [{ label: "B", resolved: true, from: 8, to: 13 }]);
    assert.deepEqual(shown(), ["world@14"]);

    holdBatches = true;
    b.edit({ changes: { from: 14, insert: "!!" }, selection: EditorSelection.cursor(16) });
    const ahead = b.binding.selectionCursors();
    b.sync.presence.set({ selection: ahead });
    await until(() => peerSelection() === JSON.stringify([ahead]), "B's caret, ahead of B's edit");
    assert.equal(a.text(), "Hello 😀 world", "B's edit is still held");
    assert.deepEqual(showB(), [{ label: "B", resolved: false }], "B's caret is in text A has not received");
    assert.deepEqual(shown(), []);
    holdBatches = false;
    await b.sync.sync();
    await until(() => (showB(), shown().length === 1), "the caret to resolve");
    assert.deepEqual(shown(), ["@16"]);

    b.sync.close();
    await until(() => a.sync.presence.peers.size === 0, "B's caret to go when B stops");
    a.check();
    assert.deepEqual([a.errors, b.errors], [[], []]);
  });

  it("drops the caret of a writer that stops sending presence once its TTL passes", async (t) => {
    // Over HTTP: a WebSocket writer's caret goes when its socket closes, before any TTL.
    const f = await fixture(t, createServer(Note), 200), a = await f.connect(), b = await f.connect({ http: true });
    await until(() => a.sync.push === "open" && b.sync.push === "open", "both push channels");
    b.sync.presence.set({ selection: null });
    b.sync.presence.set({ selection: b.binding.selectionCursors() });
    await until(() => a.sync.presence.peers.size === 1, "B's caret");
    // B's page goes away without leaving: its re-sends stop, and the host expires its state.
    b.network.set(true);
    await until(() => a.sync.presence.peers.size === 0, "B's state to expire", 5000);
  });

  it("drops a WebSocket writer's caret as soon as its socket closes, and an HTTP writer edits alongside", async (t) => {
    const f = await fixture(t), a = await f.connect({ http: true }), b = await f.connect();
    await until(() => a.sync.push === "open" && b.sync.push === "open", "both push channels");
    b.sync.presence.set({ selection: b.binding.selectionCursors() });
    await until(() => a.sync.presence.peers.size === 1, "B's caret over the socket");
    b.network.set(true); // Closes B's socket; the 30-second TTL never comes into play.
    await until(() => a.sync.presence.peers.size === 0, "B's caret to go with its socket", 2000);
    b.edit({ changes: { from: 0, insert: "offline " } });
    a.edit({ changes: { from: 0, insert: "http" } });
    b.network.set(false);
    await until(() => a.text() === b.text() && a.text().length === 12 && a.pending() === 0 && b.pending() === 0, "convergence");
    a.check(); b.check();
  });

  it("refuses a malformed cursor on the host", async (t) => {
    const f = await fixture(t), a = await f.connect();
    const clientId = a.sync.doc.checkpoint().clientId;
    const response = await fetch(f.host.url + "/sync/presence", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, state: { selection: { from: { anchor: null, bind: "up" }, to: { anchor: null, bind: "left" } } } }) });
    assert.equal(response.status, 400);
    await response.text();
    assert.throws(() => { a.sync.presence.set({ selection: null, extra: 1 } as never); }, /Invalid payload/); // oxlint-disable-line typescript/no-unsafe-type-assertion -- Invalid on purpose.
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
      "/text-editor/binding.js", "/text-editor/changes.js", "/text-editor/schema.js",
      "/shared/sync-ui.js", "/shared/presence.js"]) {
      const asset = await fetch(f.host.url + route);
      assert.equal(asset.status, 200, route);
      assert.equal(asset.headers.get("Content-Type"), "text/javascript; charset=utf-8");
      assert.equal(asset.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(asset.headers.get("Cache-Control"), "no-store");
      assert.ok((await asset.text()).length > 0);
    }
    for (const route of ["/src/index.ts", "/server.ts", "/presence-relay.ts", "/presence", "/sync-ui.js", "/browser-http-smoke/smoke.js", "/text-editor/actions.js", "/text-editor/presence.js", "/package.json",
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
    const modules = ["server.ts", "page.js", "editor.js", "binding.js", "changes.js", "../shared/presence.js"];
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
