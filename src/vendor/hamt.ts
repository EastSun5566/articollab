/*!
 * Modified from hamt_plus/lib/hamt.js at
 * https://github.com/mattbierner/hamt_plus/tree/b8845c7343fdde3966f875d732248fec597cf538
 * Code based on https://github.com/exclipy/pdata.
 *
 * Adaptations: typed string-key ESM subset; no custom hash or traversal API;
 * undefined represents empty nodes/array slots; native array copy/splice;
 * Object.is value equality; unique object edit tokens; finally-scoped transients.
 *
 * The MIT License (MIT)
 * Copyright (C) 2016 Matt Bierner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

const SIZE = 5;
const MASK = 31;
const MAX_INDEX_NODE = 16;
const MIN_ARRAY_NODE = 8;

type Edit = object | undefined;
interface Leaf<V> {
  type: 1;
  edit: Edit;
  hash: number;
  key: string;
  value: V;
}
interface Collision<V> {
  type: 2;
  edit: Edit;
  hash: number;
  children: Leaf<V>[];
}
interface IndexedNode<V> {
  type: 3;
  edit: Edit;
  mask: number;
  children: Node<V>[];
}
interface ArrayNode<V> {
  type: 4;
  edit: Edit;
  size: number;
  children: (Node<V> | undefined)[];
}
type Node<V> = Leaf<V> | Collision<V> | IndexedNode<V> | ArrayNode<V>;
type Change<V> = { type: "set"; value: V } | { type: "delete" };

function hash(key: string): number {
  let result = 0;
  for (let index = 0; index < key.length; index++) {
    result = ((result << 5) - result + key.charCodeAt(index)) | 0;
  }
  return result;
}

function popcount(value: number): number {
  value -= (value >> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >> 2) & 0x33333333);
  value = (value + (value >> 4)) & 0x0f0f0f0f;
  value += value >> 8;
  value += value >> 16;
  return value & 0x7f;
}

function fragment(shift: number, keyHash: number): number {
  return (keyHash >>> shift) & MASK;
}

function bitmapIndex(mask: number, bit: number): number {
  return popcount(mask & (bit - 1));
}

function arrayUpdate<T>(editable: boolean, index: number, value: T, array: T[]): T[] {
  const result = editable ? array : array.slice();
  result[index] = value;
  return result;
}

function arrayRemove<T>(editable: boolean, index: number, array: T[]): T[] {
  const result = editable ? array : array.slice();
  result.splice(index, 1);
  return result;
}

function arrayInsert<T>(editable: boolean, index: number, value: T, array: T[]): T[] {
  const result = editable ? array : array.slice();
  result.splice(index, 0, value);
  return result;
}

function leaf<V>(edit: Edit, keyHash: number, key: string, value: V): Leaf<V> {
  return { type: 1, edit, hash: keyHash, key, value };
}

function mergeLeaves<V>(
  edit: Edit, shift: number, left: Leaf<V> | Collision<V>, right: Leaf<V>
): Node<V> {
  if (left.hash === right.hash) {
    // Equal hashes only reach this branch with a single existing leaf.
    if (left.type !== 1) throw new Error("Unexpected HAMT collision merge");
    return { type: 2, edit, hash: left.hash, children: [right, left] };
  }
  const leftFragment = fragment(shift, left.hash);
  const rightFragment = fragment(shift, right.hash);
  return {
    type: 3, edit, mask: (1 << leftFragment) | (1 << rightFragment),
    children: leftFragment === rightFragment
      ? [mergeLeaves(edit, shift + SIZE, left, right)]
      : leftFragment < rightFragment ? [left, right] : [right, left],
  };
}

function expand<V>(edit: Edit, added: number, child: Node<V>, node: IndexedNode<V>): ArrayNode<V> {
  const children: (Node<V> | undefined)[] = [];
  let mask = node.mask;
  let count = 0;
  for (let index = 0; mask !== 0; index++, mask >>>= 1) {
    if (mask & 1) children[index] = node.children[count++]!;
  }
  children[added] = child;
  return { type: 4, edit, size: count + 1, children };
}

function pack<V>(edit: Edit, removed: number, node: ArrayNode<V>): IndexedNode<V> {
  const children: Node<V>[] = [];
  let mask = 0;
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index];
    if (index !== removed && child !== undefined) {
      children.push(child);
      mask |= 1 << index;
    }
  }
  return { type: 3, edit, mask, children };
}

function modify<V>(
  node: Node<V> | undefined, edit: Edit, shift: number,
  keyHash: number, key: string, change: Change<V>, size: { value: number }
): Node<V> | undefined {
  if (node === undefined) {
    if (change.type === "delete") return undefined;
    size.value++;
    return leaf(edit, keyHash, key, change.value);
  }
  const editable = edit !== undefined && edit === node.edit;
  switch (node.type) {
    case 1: {
      if (key === node.key) {
        if (change.type === "delete") {
          size.value--;
          return undefined;
        }
        if (Object.is(change.value, node.value)) return node;
        if (editable) {
          node.value = change.value;
          return node;
        }
        return leaf(edit, keyHash, key, change.value);
      }
      if (change.type === "delete") return node;
      size.value++;
      return mergeLeaves(edit, shift, node, leaf(edit, keyHash, key, change.value));
    }
    case 2: {
      if (keyHash !== node.hash) {
        if (change.type === "delete") return node;
        size.value++;
        return mergeLeaves(edit, shift, node, leaf(edit, keyHash, key, change.value));
      }
      for (let index = 0; index < node.children.length; index++) {
        const child = node.children[index]!;
        if (child.key !== key) continue;
        if (change.type === "set" && Object.is(change.value, child.value)) return node;
        let children: Leaf<V>[];
        if (change.type === "delete") {
          size.value--;
          children = arrayRemove(editable, index, node.children);
          if (children.length === 1) return children[0]!;
        } else {
          children = arrayUpdate(editable, index, leaf(edit, keyHash, key, change.value), node.children);
        }
        if (editable) {
          node.children = children;
          return node;
        }
        return { type: 2, edit, hash: keyHash, children };
      }
      if (change.type === "delete") return node;
      size.value++;
      const children = arrayUpdate(editable, node.children.length, leaf(edit, keyHash, key, change.value), node.children);
      return editable ? node : { type: 2, edit, hash: keyHash, children };
    }
    case 3: {
      const keyFragment = fragment(shift, keyHash);
      const bit = 1 << keyFragment;
      const index = bitmapIndex(node.mask, bit);
      const exists = (node.mask & bit) !== 0;
      const current = exists ? node.children[index]! : undefined;
      const child = modify(current, edit, shift + SIZE, keyHash, key, change, size);
      if (current === child) return node;
      let mask = node.mask;
      let children: Node<V>[];
      if (exists && child === undefined) {
        mask &= ~bit;
        if (mask === 0) return undefined;
        const sibling = node.children[index ^ 1];
        if (node.children.length <= 2 && sibling !== undefined && sibling.type <= 2) return sibling;
        children = arrayRemove(editable, index, node.children);
      } else if (!exists && child !== undefined) {
        if (node.children.length >= MAX_INDEX_NODE) return expand(edit, keyFragment, child, node);
        mask |= bit;
        children = arrayInsert(editable, index, child, node.children);
      } else {
        children = arrayUpdate(editable, index, child!, node.children);
      }
      if (editable) {
        node.mask = mask;
        node.children = children;
        return node;
      }
      return { type: 3, edit, mask, children };
    }
    case 4: {
      const index = fragment(shift, keyHash);
      const current = node.children[index];
      const child = modify(current, edit, shift + SIZE, keyHash, key, change, size);
      if (current === child) return node;
      let count = node.size;
      if (current === undefined && child !== undefined) count++;
      else if (current !== undefined && child === undefined) {
        count--;
        if (count <= MIN_ARRAY_NODE) return pack(edit, index, node);
      }
      const children = arrayUpdate(editable, index, child, node.children);
      if (editable) {
        node.size = count;
        node.children = children;
        return node;
      }
      return { type: 4, edit, size: count, children };
    }
  }
  throw new Error("Unknown HAMT node");
}

/** Internal string-key persistent map. Ordering belongs to IdList, not this map. */
export class HamtMap<V> {
  private root: Node<V> | undefined;
  private edit: Edit;
  private count: number;

  private constructor(root: Node<V> | undefined, count: number, edit?: object) {
    this.root = root;
    this.count = count;
    this.edit = edit;
  }

  static empty<V>(): HamtMap<V> {
    return new HamtMap<V>(undefined, 0);
  }

  get size(): number {
    return this.count;
  }

  get(key: string): V | undefined {
    const keyHash = hash(key);
    let node = this.root;
    let shift = 0;
    while (node !== undefined) {
      switch (node.type) {
        case 1: return node.key === key ? node.value : undefined;
        case 2:
          if (keyHash === node.hash) {
            for (const child of node.children) if (child.key === key) return child.value;
          }
          return undefined;
        case 3: {
          const bit = 1 << fragment(shift, keyHash);
          if (!(node.mask & bit)) return undefined;
          node = node.children[bitmapIndex(node.mask, bit)];
          break;
        }
        case 4: node = node.children[fragment(shift, keyHash)]; break;
      }
      shift += SIZE;
    }
    return undefined;
  }

  set(key: string, value: V): HamtMap<V> {
    return this.update(key, { type: "set", value });
  }

  delete(key: string): HamtMap<V> {
    return this.update(key, { type: "delete" });
  }

  /** Draft updates are scoped to this callback; async/nested mutation is unsupported. */
  mutate(callback: (draft: HamtMap<V>) => undefined): HamtMap<V> {
    if (this.edit !== undefined) throw new Error("Nested HAMT mutation is not supported");
    const draft = new HamtMap(this.root, this.count, {});
    try {
      callback(draft);
      return draft;
    } finally {
      draft.edit = undefined;
    }
  }

  private update(key: string, change: Change<V>): HamtMap<V> {
    const size = { value: this.count };
    const root = modify(this.root, this.edit, 0, hash(key), key, change, size);
    if (this.edit !== undefined) {
      this.root = root;
      this.count = size.value;
      return this;
    }
    return root === this.root ? this : new HamtMap(root, size.value);
  }
}
