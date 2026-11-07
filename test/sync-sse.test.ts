import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readServerSentEvents, type ServerSentEvent } from "../src/sync/sse.ts";

/** Streams `text` split at the given character offsets, encoded as UTF-8. */
function chunked(text: string, cuts: readonly number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const points = [0, ...cuts.filter((cut) => cut > 0 && cut < bytes.length), bytes.length];
  return new ReadableStream({
    start(controller) {
      for (let index = 1; index < points.length; index++) controller.enqueue(bytes.slice(points[index - 1], points[index]));
      controller.close();
    },
  });
}

async function events(text: string, cuts: readonly number[] = []) {
  const seen: ServerSentEvent[] = [];
  let activity = 0;
  await readServerSentEvents(chunked(text, cuts), (event) => seen.push(event), () => { activity++; });
  return { seen, activity };
}

describe("readServerSentEvents", () => {
  it("dispatches typed events with ids and multi-line data, ignoring comments", async () => {
    const { seen, activity } = await events(": ping\n\nevent: commits\nid: 7\ndata: [1,\ndata: 2]\n\ndata:plain\n\n");
    assert.deepEqual(seen, [
      { type: "commits", data: "[1,\n2]", id: "7" },
      { type: "message", data: "plain", id: "7" },
    ]);
    assert.equal(activity, 9, "every complete line, comments and blank lines included, counts as activity");
  });

  it("gives the same events however the bytes are split, across CRLF, CR and multi-byte characters", async () => {
    const text = "event: commits\r\ndata: 「中文」😀\r\n\r\nevent: gap\rdata: null\r\r: keep\n\n";
    const expected = (await events(text)).seen;
    assert.deepEqual(expected.map((event) => [event.type, event.data]), [["commits", "「中文」😀"], ["gap", "null"]]);
    const length = new TextEncoder().encode(text).length;
    for (let cut = 1; cut < length; cut++) {
      assert.deepEqual((await events(text, [cut])).seen, expected, `split at byte ${cut}`);
    }
    for (let cut = 1; cut + 3 < length; cut += 3) {
      assert.deepEqual((await events(text, [cut, cut + 1, cut + 3])).seen, expected, `split near ${cut}`);
    }
  });

  it("discards an event without its blank line and events with no data", async () => {
    assert.deepEqual((await events("event: commits\n\ndata: complete\n\nevent: commits\ndata: cut off")).seen,
      [{ type: "message", data: "complete", id: undefined }]);
    assert.deepEqual((await events("id: 3\nretry: 10\nunknown: x\n\n")).seen, []);
  });
});
