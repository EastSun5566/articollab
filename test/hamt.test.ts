import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HamtMap } from "../src/vendor/hamt.ts";

describe("vendored HAMT", () => {
  it("handles equal-hash keys and collision collapse without changing older versions", () => {
    // All four keys have the same upstream polynomial string hash.
    const keys = ["AaAa", "AaBB", "BBAa", "BBBB"];
    const original = HamtMap.empty<number>().mutate((draft) => {
      keys.forEach((key, index) => draft.set(key, index));
    });
    const updated = original.set(keys[1]!, 100);
    const collapsed = updated.delete(keys[0]!).delete(keys[1]!).delete(keys[2]!);
    assert.equal(collapsed.size, 1);
    assert.equal(collapsed.get(keys[3]!), 3);
    assert.equal(collapsed.delete(keys[3]!).size, 0);
    keys.forEach((key, index) => assert.equal(original.get(key), index));
    assert.equal(updated.get(keys[1]!), 100);
    assert.strictEqual(updated.delete("missing"), updated);
    assert.strictEqual(updated.set(keys[1]!, 100), updated);
    const merged = updated.set("different hash", 4);
    keys.forEach((key, index) => assert.equal(merged.get(key), index === 1 ? 100 : index));
    assert.equal(merged.get("different hash"), 4);
  });

  it("expands and packs sparse/dense nodes including newly filled array slots", () => {
    // Single character hashes cover every root fragment, including bit 31.
    const keys = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index));
    const sparse = HamtMap.empty<number>().mutate((draft) => {
      for (let index = 0; index < 16; index++) draft.set(keys[index]!, index);
    });
    let dense = sparse;
    for (let index = 16; index < keys.length; index++) dense = dense.set(keys[index]!, index);
    assert.equal(dense.size, 32);
    let packed = dense;
    for (let index = 0; index < 25; index++) packed = packed.delete(keys[index]!);
    assert.equal(packed.size, 7);
    const refill = packed.mutate((draft) => {
      for (let index = 0; index < 25; index++) draft.set(keys[index]!, -index);
    });
    keys.forEach((key, index) => {
      assert.equal(sparse.get(key), index < 16 ? index : undefined);
      assert.equal(dense.get(key), index);
      assert.equal(packed.get(key), index < 25 ? undefined : index);
      assert.ok(Object.is(refill.get(key), index < 25 ? -index : index));
    });
    assert.equal(refill.size, 32);
  });

  it("matches native Map over deterministic persistent and bulk updates", () => {
    const keys = ["AaAa", "AaBB", "BBAa", "BBBB",
      ...Array.from({ length: 256 }, (_, index) => `key-${index}`)];
    let map = HamtMap.empty<number | null>();
    const expected = new Map<string, number | null>();
    let seed = 0xdeadbeef;
    for (let step = 0; step < 4_000; step++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const key = keys[seed % keys.length]!;
      if ((seed >>> 16) % 3 === 0) {
        map = map.delete(key);
        expected.delete(key);
      } else {
        const value = step % 11 === 0 ? null : step % 7 === 0 ? -0 : step;
        if (step % 5 === 0) map = map.mutate((draft) => { draft.set(key, value); });
        else map = map.set(key, value);
        expected.set(key, value);
      }
      assert.equal(map.size, expected.size);
      if (step % 25 === 0) {
        for (const candidate of keys) assert.ok(Object.is(map.get(candidate), expected.get(candidate)));
      }
    }
    const emptied = map.mutate((draft) => { for (const key of keys) draft.delete(key); });
    assert.equal(emptied.size, 0);
    for (const key of keys) {
      assert.equal(emptied.get(key), undefined);
      assert.ok(Object.is(map.get(key), expected.get(key)));
    }
  });

  it("isolates sibling versions and repeated bulk sessions", () => {
    const base = HamtMap.empty<number>().mutate((draft) => {
      for (let index = 0; index < 128; index++) draft.set(`key-${index}`, index);
    });
    const left = base.mutate((draft) => { draft.set("key-0", 200); draft.delete("key-1"); });
    const right = base.mutate((draft) => { draft.set("key-0", 300); draft.delete("key-2"); });
    const later = left.mutate((draft) => { draft.set("key-3", 400); });
    assert.equal(base.get("key-0"), 0);
    assert.equal(left.get("key-0"), 200);
    assert.equal(right.get("key-0"), 300);
    assert.equal(base.get("key-1"), 1);
    assert.equal(left.get("key-1"), undefined);
    assert.equal(right.get("key-1"), 1);
    assert.equal(left.get("key-2"), 2);
    assert.equal(right.get("key-2"), undefined);
    assert.equal(left.get("key-3"), 3);
    assert.equal(later.get("key-3"), 400);
    const persistent = later.set("key-0", 500);
    assert.equal(later.get("key-0"), 200);
    assert.equal(persistent.get("key-0"), 500);
  });

  it("finalizes drafts even when a bulk callback throws", () => {
    const base = HamtMap.empty<number>().set("Aa", 1).set("BB", 2);
    const captured: HamtMap<number>[] = [];
    const failure = new Error("stop bulk update");
    assert.throws(() => base.mutate((draft) => {
      captured.push(draft);
      draft.set("Aa", 3);
      draft.delete("BB");
      throw failure;
    }), (error: unknown) => error === failure);
    assert.equal(base.get("Aa"), 1);
    assert.equal(base.get("BB"), 2);
    // Deliberately capture a draft to verify finally has disabled its editing.
    const failed = captured[0]!;
    const next = failed.set("Aa", 4);
    assert.notStrictEqual(next, failed);
    assert.equal(failed.get("Aa"), 3);
    assert.equal(next.get("Aa"), 4);
    const completed = base.mutate((draft) => { captured.push(draft); draft.set("Aa", 5); });
    assert.strictEqual(completed, captured[1]);
    assert.notStrictEqual(completed.set("Aa", 6), completed);
    assert.equal(completed.get("Aa"), 5);
    assert.throws(() => base.mutate((draft) => { draft.mutate(() => {}); }));
    assert.equal(base.get("Aa"), 1);
  });

  it("preserves payload references, falsy values and signed zero", () => {
    const payload = { nested: { value: 1 } };
    const values = [null, false, "", 0, -0, payload] as const;
    const map = HamtMap.empty<(typeof values)[number]>().mutate((draft) => {
      values.forEach((value, index) => draft.set(String(index), value));
    });
    values.forEach((value, index) => assert.ok(Object.is(map.get(String(index)), value)));
    assert.strictEqual(map.get("5"), payload);
    const changed = map.set("3", -0);
    assert.ok(Object.is(changed.get("3"), -0));
    assert.ok(Object.is(map.get("3"), 0));
    assert.strictEqual(changed.set("3", -0), changed);
    const collision = HamtMap.empty<number>().set("Aa", 0).set("BB", 1);
    assert.ok(Object.is(collision.set("Aa", -0).get("Aa"), -0));
    assert.ok(Object.is(collision.get("Aa"), 0));
  });
});
