import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEditorActions } from "../actions.js";

function pane() {
  let composing = false, blocked = false, calls = 0;
  const locks: boolean[] = [];
  return { locks, get calls() { return calls; },
    set composing(next: boolean) { composing = next; }, set blocked(next: boolean) { blocked = next; },
    isComposing: () => composing, isBlocked: () => blocked,
    setReadOnly(next: boolean) { locks.push(next); },
    async sync() { calls++; return true; }, async rejectPending() { calls++; return true; },
  };
}

describe("page-wide editor action guard", () => {
  it("rejects composition before network calls or read-only changes", async () => {
    const a = pane(), b = pane(), actions = createEditorActions([a, b]);
    b.composing = true;
    await assert.rejects(actions.run(0, "sync"));
    await assert.rejects(actions.run(0, "rejectPending"));
    assert.equal(a.calls, 0); assert.deepEqual(a.locks, []);
    assert.equal(actions.failed, false);
    b.composing = false;
    assert.equal(await actions.run(0, "sync"), true);
  });

  it("locks both panes and rejects concurrent and reentrant work without stopping the first", async () => {
    const a = pane(), b = pane();
    let complete!: (value: boolean) => void;
    a.sync = () => new Promise<boolean>((resolve) => { complete = resolve; });
    const actions = createEditorActions([a, b]);
    const first = actions.run(0, "sync");
    assert.equal(actions.busy, true);
    assert.deepEqual(a.locks, [true]); assert.deepEqual(b.locks, [true]);
    await assert.rejects(actions.run(1, "rejectPending"));
    assert.equal(actions.failed, false);
    complete(true);
    assert.equal(await first, true);
    assert.deepEqual(a.locks, [true, false]); assert.deepEqual(b.locks, [true, false]);
  });

  it("keeps blocked panes read-only after incomplete synchronization", async () => {
    const a = pane(), b = pane();
    a.blocked = true; a.sync = async () => false;
    const actions = createEditorActions([a, b]);
    assert.equal(await actions.run(0, "sync"), false);
    assert.deepEqual(a.locks, [true, true]); assert.deepEqual(b.locks, [true, false]);
    assert.equal(actions.failed, false);
    a.blocked = false;
    assert.equal(await actions.run(0, "rejectPending"), true);
    assert.equal(a.locks.at(-1), false);
  });

  it("keeps the first network error even if locking the broken view throws", async () => {
    const failure = new Error("response lost"), secondary = new Error("view unavailable");
    const a = pane(), b = pane();
    a.sync = async () => { b.setReadOnly = () => { throw secondary; }; throw failure; };
    const actions = createEditorActions([a, b]);
    await assert.rejects(actions.run(0, "sync"), (error) => error === failure);
    assert.equal(actions.busy, false);
    assert.equal(actions.failed, true);
    assert.equal(actions.stop(secondary), failure);
    await assert.rejects(actions.run(0, "rejectPending"), (error) => error === failure);
    assert.equal(a.locks.at(-1), true);
  });
});
