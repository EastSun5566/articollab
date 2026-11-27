import assert from "node:assert/strict";
import { it } from "node:test";
import { chromium } from "playwright";
import { createServer } from "../../../../dist/index.js";
import { keepSafeLinks, Note } from "../../schema.js";
import { startRichEditorServer } from "../../server.ts";

it("keeps IME candidates local and synchronizes only confirmed text", { timeout: 30_000 }, async (t) => {
  const server = createServer(Note, { resolve: keepSafeLinks });
  const host = await startRichEditorServer(server);
  t.after(() => host.close());
  const browser = await chromium.launch({ timeout: 10_000 });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(host.url);
  await page.getByRole("heading", { name: "Writer A Live", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Writer B Live", exact: true }).waitFor();

  const writerA = '[aria-label="Writer A text"]';
  const writerB = '[aria-label="Writer B text"]';
  await page.locator(writerA).click();
  const cdp = await page.context().newCDPSession(page);

  async function showCandidate(text: string): Promise<void> {
    await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  }

  async function waitForText(a: string, b: string): Promise<void> {
    const ready = await page.waitForFunction((expected) =>
      document.querySelector(expected.writerA)?.textContent === expected.a &&
      document.querySelector(expected.writerB)?.textContent === expected.b,
      { writerA, writerB, a, b });
    await ready.dispose();
  }

  for (const candidate of ["ㄏ", "ㄏㄠ", "郝"]) {
    await showCandidate(candidate);
    await waitForText(candidate, "");
    assert.deepEqual(server.commitsSince(0), []);
  }

  await cdp.send("Input.insertText", { text: "好" });
  await waitForText("好", "好");
  const confirmed = server.commitsSince(0);
  assert.ok(confirmed);
  assert.equal(confirmed.length, 1);
  const commit = confirmed[0];
  assert.ok(commit);
  assert.deepEqual(commit.source, { clientId: "client-1", seq: 1 });
  assert.equal(commit.operations.length, 1);
  const operation = commit.operations[0];
  assert.equal(operation?.type, "text/insert");
  assert.equal(operation.value, "好");

  await showCandidate("ㄏ");
  await waitForText("好ㄏ", "好");
  assert.deepEqual(server.commitsSince(1), []);
  await showCandidate("");
  await waitForText("好", "好");
  assert.deepEqual(server.commitsSince(1), []);

  // A later edit reaching B proves A can still submit and that no cancelled batch was queued ahead of it.
  await page.keyboard.press("!");
  await waitForText("好!", "好!");
  const afterCancel = server.commitsSince(1);
  assert.ok(afterCancel);
  assert.equal(afterCancel.length, 1);
  assert.deepEqual(afterCancel[0]?.source, { clientId: "client-1", seq: 2 });
});
