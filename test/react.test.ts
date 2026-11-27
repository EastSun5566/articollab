import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  counter, counterMap, createClient, createServer, createUndoManager, defineDocument, list, map, text, value,
  type ClientBatch, type ClientDocument, type DocumentOperation,
} from "../src/index.ts";
import {
  shallowEqual, useCollection, useDocument, usePeers, useSyncStatus, useTextBlocks, useTextDelta, useUndoState,
} from "../src/react.ts";
import type { PresenceSyncClient, SyncClient, SyncPushState, SyncStatus } from "../src/sync/index.ts";

// A DOM for react-dom, and the flag that lets act() flush updates.
const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });

type Todo = { title: string; done: boolean };
const Board = defineDocument({
  title: value("Groceries"),
  items: list<Todo>(),
  body: text({ marks: { bold: { expand: "after" } }, blocks: { heading: {} } }),
  tags: map<string>(),
  likes: counter(),
  votes: counterMap(),
});
type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- The usual exact type equality check.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

/** A server and writers whose batches move only when `sync()` runs. */
function network() {
  const server = createServer(Board);
  const writers: { doc: ClientDocument<Shape>; outbox: Batch[] }[] = [];
  function writer() {
    const outbox: Batch[] = [];
    const doc = createClient(Board, { clientId: server.openClient(), onBatch: (batch) => { outbox.push(batch); } });
    writers.push({ doc, outbox });
    return { doc, outbox };
  }
  function sync() {
    for (const { outbox } of writers) for (const batch of outbox.splice(0)) server.receive(batch);
    for (const { doc } of writers) {
      for (const commit of server.commitsSince(doc.checkpoint().snapshot.serverSeq) ?? []) doc.receive(commit);
    }
  }
  return { server, writer, sync };
}

/** Renders `node` into a fresh root, unmounted after the test. */
function render(t: TestContext, node: ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => { root.render(node); });
  t.after(() => { act(() => { root.unmount(); }); });
  return {
    container,
    rerender(next: ReactNode) { act(() => { root.render(next); }); },
    unmount() { act(() => { root.unmount(); }); },
  };
}

/** A component that records each value its hook returns, and how often it rendered. */
function probe<T>(read: () => T) {
  const seen: T[] = [];
  function Probe() { seen.push(read()); return null; }
  return { Probe, seen, get last() { return seen.at(-1); } };
}

describe("useCollection", () => {
  it("returns each kind of collection's visible state, typed from the schema", (t) => {
    const doc = network().writer().doc;
    doc.transact(() => {
      doc.state.items.push({ title: "milk", done: false });
      doc.state.body.insert(0, "Hi");
      doc.state.tags.set("milk", "dairy");
      doc.state.likes.add(2);
      doc.state.votes.add("milk", 3);
    });
    const read = probe(() => ({
      title: useCollection(doc, "title"),
      items: useCollection(doc, "items"),
      body: useCollection(doc, "body"),
      tags: useCollection(doc, "tags"),
      likes: useCollection(doc, "likes"),
      votes: useCollection(doc, "votes"),
    }));
    render(t, createElement(read.Probe));
    assert.deepEqual(read.last, {
      title: "Groceries", items: [{ title: "milk", done: false }], body: "Hi", tags: { milk: "dairy" }, likes: 2, votes: { milk: 3 },
    });
    assert.ok(Object.isFrozen(read.last?.items) && Object.isFrozen(read.last?.tags));
    type Of<K extends keyof Shape> = ReturnType<typeof useCollection<Shape, K>>;
    const types: [
      Expect<Equal<Of<"title">, string>>, Expect<Equal<Of<"items">, readonly Todo[]>>, Expect<Equal<Of<"body">, string>>,
      Expect<Equal<Of<"tags">, Readonly<Record<string, string>>>>, Expect<Equal<Of<"likes">, number>>,
      Expect<Equal<Of<"votes">, Readonly<Record<string, number>>>>,
    ] = [true, true, true, true, true, true];
    assert.equal(types.length, 6);
    // @ts-expect-error Not a path of this schema.
    assert.throws(() => { useCollection(doc, "nope"); }, TypeError);
  });

  it("re-renders only the components whose collection changed, and keeps unchanged snapshots", (t) => {
    const doc = network().writer().doc;
    const items = probe(() => useCollection(doc, "items"));
    const title = probe(() => useCollection(doc, "title"));
    const body = probe(() => useCollection(doc, "body"));
    render(t, [createElement(items.Probe, { key: 1 }), createElement(title.Probe, { key: 2 }), createElement(body.Probe, { key: 3 })]);
    const first = items.last;
    act(() => { doc.state.items.push({ title: "milk", done: false }); });
    assert.equal(items.seen.length, 2);
    assert.equal(title.seen.length, 1, "the title did not change");
    assert.equal(body.seen.length, 1);
    assert.notEqual(items.last, first);
    act(() => { doc.state.title.value = "Groceries"; }); // The same value.
    assert.equal(title.seen.length, 1);
    act(() => { doc.state.title.value = "Shopping"; });
    assert.deepEqual(title.seen, ["Groceries", "Shopping"]);
    act(() => { doc.state.body.insert(0, "a"); doc.state.body.format(0, 1, "bold", true); });
    assert.deepEqual(body.seen, ["", "a"], "a format alone does not change the text");
    assert.equal(items.seen.length, 2);
  });

  it("shares one observe() between components and stops it when the last one unmounts", (t) => {
    const doc = network().writer().doc;
    let subscribed = 0, stopped = 0;
    const observe = doc.state.items.observe.bind(doc.state.items);
    t.mock.method(doc.state.items, "observe", (listener: Parameters<typeof observe>[0]) => {
      subscribed++;
      const stop = observe(listener);
      return () => { stopped++; stop(); };
    });
    const a = probe(() => useCollection(doc, "items")), b = probe(() => useCollection(doc, "items"));
    const view = render(t, [createElement(a.Probe, { key: 1 }), createElement(b.Probe, { key: 2 })]);
    act(() => { doc.state.items.push({ title: "eggs", done: false }); });
    assert.equal(a.last, b.last, "one snapshot for both");
    assert.equal(subscribed, 1);
    view.unmount();
    assert.equal(stopped, 1);
  });

  it("follows remote commits, rejected pending work and undo", (t) => {
    const { server, writer, sync } = network();
    const a = writer(), b = writer();
    const history = createUndoManager(a.doc);
    const items = probe(() => useCollection(a.doc, "items"));
    const likes = probe(() => useCollection(a.doc, "likes"));
    render(t, [createElement(items.Probe, { key: 1 }), createElement(likes.Probe, { key: 2 })]);
    act(() => { b.doc.state.items.push({ title: "from b", done: false }); b.doc.state.likes.add(1); sync(); });
    assert.deepEqual(items.last, [{ title: "from b", done: false }]);
    assert.equal(likes.last, 1);
    act(() => { a.doc.state.likes.add(5); });
    assert.equal(likes.last, 6);
    act(() => {
      for (const batch of a.outbox.splice(0)) a.doc.receive(server.reject(batch).commit);
    });
    assert.equal(likes.last, 1, "the server rejected the addition");
    act(() => { a.doc.state.items.push({ title: "mine", done: false }); });
    act(() => { history.undo(); });
    assert.deepEqual(items.last, [{ title: "from b", done: false }]);
  });

  it("subscribes again when the document changes, also in StrictMode", (t) => {
    const { writer } = network();
    const first = writer().doc, second = writer().doc;
    second.state.items.push({ title: "second", done: true });
    let doc = first;
    const items = probe(() => useCollection(doc, "items"));
    const view = render(t, createElement(StrictMode, null, createElement(items.Probe)));
    act(() => { first.state.items.push({ title: "first", done: false }); });
    assert.deepEqual(items.last, [{ title: "first", done: false }]);
    doc = second;
    view.rerender(createElement(StrictMode, null, createElement(items.Probe)));
    assert.deepEqual(items.last, [{ title: "second", done: true }]);
    act(() => { second.state.items.push({ title: "more", done: false }); });
    assert.equal(items.last?.length, 2);
  });
});

describe("useTextDelta and useTextBlocks", () => {
  it("follow marks and paragraph attributes", (t) => {
    const doc = network().writer().doc;
    const delta = probe(() => useTextDelta(doc, "body"));
    const blocks = probe(() => useTextBlocks(doc, "body"));
    render(t, [createElement(delta.Probe, { key: 1 }), createElement(blocks.Probe, { key: 2 })]);
    act(() => { doc.state.body.insert(0, "Title\nbody"); });
    act(() => { doc.state.body.format(0, 5, "bold", true); });
    assert.deepEqual(delta.last, [{ insert: "Title", attributes: { bold: true } }, { insert: "\nbody" }]);
    const rendered = blocks.seen.length;
    act(() => { doc.state.body.formatBlocks(0, 0, "heading", 1); });
    assert.deepEqual(blocks.last, [{ index: 0, length: 5, attributes: { heading: 1 } }, { index: 6, length: 4, attributes: {} }]);
    assert.equal(blocks.seen.length, rendered + 1);
    act(() => { doc.state.body.format(6, 1, "bold", true); });
    assert.equal(blocks.seen.length, rendered + 1, "a mark leaves the paragraphs alone");
    // @ts-expect-error Not a Text.
    assert.throws(() => { useTextDelta(doc, "items"); }, TypeError);
  });
});

describe("useDocument", () => {
  it("re-renders only when the selected result changes, with an inline selector", (t) => {
    const doc = network().writer().doc;
    const done = probe(() => useDocument(doc, (state) => state.items.toArray().filter((todo) => todo.done).length));
    const titles = probe(() => useDocument(doc, (state) => state.items.toArray().map((todo) => todo.title)));
    render(t, [createElement(done.Probe, { key: 1 }), createElement(titles.Probe, { key: 2 })]);
    act(() => { doc.state.items.push({ title: "milk", done: false }); });
    assert.deepEqual(done.seen, [0], "still none done");
    assert.deepEqual(titles.last, ["milk"]);
    const before = titles.last;
    act(() => { doc.state.items.set(0, { title: "milk", done: true }); });
    assert.deepEqual(done.seen, [0, 1]);
    assert.equal(titles.last, before, "equal titles keep their identity");
    act(() => { doc.state.likes.add(1); });
    assert.equal(done.seen.length, 2);
  });

  it("uses isEqual to decide", (t) => {
    const doc = network().writer().doc;
    const seen = probe(() => useDocument(doc, (state) => ({ count: state.items.length }), (left, right) => left.count === right.count));
    render(t, createElement(seen.Probe));
    act(() => { doc.state.likes.add(1); });
    assert.equal(seen.seen.length, 1);
    act(() => { doc.state.items.push({ title: "milk", done: false }); });
    assert.deepEqual(seen.last, { count: 1 });
    assert.equal(shallowEqual([1, { a: 1 }], [1, { a: 1 }]), false, "shallow: nested objects compare by identity");
    assert.equal(shallowEqual({ a: 1, b: "x" }, { b: "x", a: 1 }), true);
  });
});

describe("useSyncStatus, usePeers and useUndoState", () => {
  /** A stand-in sync client whose status, push channel and peers the test sets. */
  function fakeSync() {
    const listeners = { status: new Set<(status: SyncStatus) => void>(), push: new Set<(push: SyncPushState) => void>(), peers: new Set<() => void>() };
    const state = { status: "syncing" as SyncStatus, push: "off" as SyncPushState, error: undefined as unknown, peers: new Map<string, string>() };
    const client = {
      get status() { return state.status; }, get push() { return state.push; }, get error() { return state.error; },
      on(event: "status" | "push", listener: (value: never) => void) {
        const set = listeners[event] as Set<(value: never) => void>;
        set.add(listener);
        return () => { set.delete(listener); };
      },
      presence: {
        get peers() { return state.peers; },
        on(_event: "change", listener: () => void) { listeners.peers.add(listener); return () => { listeners.peers.delete(listener); }; },
      },
    };
    return {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the members these hooks read.
      client: client as unknown as PresenceSyncClient<Shape, string> & SyncClient<Shape>,
      setStatus(status: SyncStatus) { state.status = status; for (const listener of listeners.status) listener(status); },
      setPush(push: SyncPushState) { state.push = push; for (const listener of listeners.push) listener(push); },
      setPeers(peers: Map<string, string>) { state.peers = peers; for (const listener of listeners.peers) listener(); },
    };
  }

  it("follow the sync client, its peers and the undo manager", (t) => {
    const sync = fakeSync();
    const doc = network().writer().doc;
    const history = createUndoManager(doc, { captureTimeout: 0 });
    const status = probe(() => useSyncStatus(sync.client));
    const peers = probe(() => usePeers(sync.client));
    const undo = probe(() => useUndoState(history));
    render(t, [createElement(status.Probe, { key: 1 }), createElement(peers.Probe, { key: 2 }), createElement(undo.Probe, { key: 3 })]);
    assert.deepEqual(status.last, { status: "syncing", push: "off", error: undefined });
    act(() => { sync.setStatus("idle"); sync.setPush("open"); });
    assert.deepEqual(status.last, { status: "idle", push: "open", error: undefined });
    const rendered = status.seen.length;
    act(() => { sync.setStatus("idle"); });
    assert.equal(status.seen.length, rendered, "the same status");
    act(() => { sync.setPeers(new Map([["client-2", "Ann"]])); });
    assert.deepEqual([...(peers.last ?? [])], [["client-2", "Ann"]]);
    assert.deepEqual(undo.last, { canUndo: false, canRedo: false });
    act(() => { doc.state.likes.add(1); });
    assert.deepEqual(undo.last, { canUndo: true, canRedo: false });
    act(() => { history.undo(); });
    assert.deepEqual(undo.last, { canUndo: false, canRedo: true });
  });
});
