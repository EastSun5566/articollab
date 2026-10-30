import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createServer, decodeServerCheckpoint, defineDocument, value,
  type DocumentOperation, type ServerCommit,
} from "../src/index.ts";

const Counter = defineDocument({ count: value(0) });
type Commit = ServerCommit<DocumentOperation<typeof Counter.definition>>;

const sequences = (commits: readonly Commit[] | null) => commits?.map((commit) => commit.serverSeq) ?? null;

describe("Server commit history window", () => {
  for (const limit of [0, 1, 3, 1000]) it(`matches a naive retained window with historyLimit=${limit}`, () => {
    let server = createServer(Counter, { historyLimit: limit });
    const clientId = server.openClient();
    const all: Commit[] = [];
    let compactions = 0;
    // 5000 commits with one restore at 2500: retention compacts after 1024 evictions, so every limit
    // compacts before and after the restore.
    for (let seq = 1; seq <= 5000; seq++) {
      const batch = { clientId, seq, operations: [{ type: "value/set" as const, path: "count" as const, value: seq }] };
      all.push((seq % 7 === 0 ? server.reject(batch) : server.receive(batch)).commit);
      if (seq === 2500) {
        server = createServer(Counter, { historyLimit: limit,
          checkpoint: decodeServerCheckpoint(Counter, JSON.parse(JSON.stringify(server.checkpoint()))) });
      }
      // Every step: a compaction defect is only visible on the commit that triggers compaction.
      const retained = limit === 0 ? [] : all.slice(-limit);
      const history = server.checkpoint().history;
      assert.deepEqual(sequences(history), sequences(retained), `checkpoint at ${seq}`);
      if (seq < 2500 && retained.length > 0) {
        assert.strictEqual(history[0], retained[0]);
        assert.strictEqual(history.at(-1), retained.at(-1));
      }
      const oldest = retained[0]?.serverSeq ?? seq + 1;
      for (const watermark of new Set([0, oldest - 2, oldest - 1, oldest, seq - 1, seq])) {
        if (watermark < 0 || watermark > seq) continue;
        const expected = watermark === seq ? [] : watermark < oldest - 1 ? null : all.slice(watermark);
        assert.deepEqual(sequences(server.commitsSince(watermark)), sequences(expected), `commitsSince(${watermark}) at ${seq}`);
      }
      // A restore starts a fresh window that is already full, so evictions restart from 2500.
      const evicted = seq <= 2500 ? seq - limit : seq - 2500;
      if (limit > 0 && evicted > 0 && evicted % 1024 === 0) compactions++;
    }
    if (limit > 0) assert.ok(compactions >= 2, "the run must cross compaction");
  });

  it("keeps a restored, frozen history array untouched while appending", () => {
    const source = createServer(Counter, { historyLimit: 2 });
    const clientId = source.openClient();
    for (let seq = 1; seq <= 2; seq++) source.receive({ clientId, seq, operations: [{ type: "value/set", path: "count", value: seq }] });
    const checkpoint = source.checkpoint();
    assert.ok(Object.isFrozen(checkpoint.history));
    const restored = createServer(Counter, { historyLimit: 2, checkpoint });
    restored.receive({ clientId, seq: 3, operations: [{ type: "value/set", path: "count", value: 3 }] });
    assert.deepEqual(sequences(checkpoint.history), [1, 2]);
    assert.deepEqual(sequences(restored.checkpoint().history), [2, 3]);
    assert.equal(restored.commitsSince(0), null);
  });
});
