import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "docs");
const output = join(root, ".docs-site");
const prefix = "/articollab/";
const pages = ["README.md", "quick-start.md", "concepts.md", "collections.md",
  "transactions.md", "server-wire.md", "recovery.md", "reference.md", "faq.md"];
const files = ["index.html", "_sidebar.md", ".nojekyll", ...pages];
const retiredPages = ["development.md", "examples.md"];
const execute = promisify(execFile);

async function requireRegular(path: string): Promise<void> {
  const stat = await lstat(path);
  assert.ok(stat.isFile(), `Expected a regular file: ${path}`);
}

/** Stage only the fixed docs assets, never the whole checkout. */
export async function buildDocs(): Promise<void> {
  await mkdir(output, { recursive: true });
  assert.ok((await lstat(output)).isDirectory(), "Staging must not be a symlink");
  const stagedFiles = await readdir(output);
  for (const name of stagedFiles) {
    assert.ok(files.includes(name) || retiredPages.includes(name), `Unexpected staging asset: ${name}`);
    await requireRegular(join(output, name));
  }
  const sourceFiles = files.filter((name) => name !== ".nojekyll");
  assert.deepEqual((await readdir(source)).sort(), [...sourceFiles].sort(), "Keep docs assets on the allowlist");
  for (const name of retiredPages) {
    if (stagedFiles.includes(name)) await rm(join(output, name));
  }
  for (const name of sourceFiles) {
    await requireRegular(join(source, name));
    await copyFile(join(source, name), join(output, name));
  }
  await writeFile(join(output, ".nojekyll"), "");
  console.log("Staged docs in .docs-site/");
}

// Matches this site's plain Markdown heading/link style, not a general Markdown parser.
function withoutCode(markdown: string): string {
  return markdown.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
}

function headingId(heading: string): string {
  return heading.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-");
}

/** Check staged links/assets, then typecheck and execute the exact documented Counter. */
export async function checkDocs(): Promise<void> {
  // Reader and contributor links must work directly in the checkout too.
  for (const name of ["README.md", "CONTRIBUTING.md", "examples/README.md",
    ...[...pages, "_sidebar.md"].map((page) => "docs/" + page)]) {
    const filename = join(root, name);
    const markdown = await readFile(filename, "utf8");
    for (const match of withoutCode(markdown).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1]!;
      if (/^https:\/\//.test(link)) continue;
      const [file, anchor] = link.split("#");
      const target = file === "" ? filename : join(dirname(filename), file!);
      await requireRegular(target);
      if (anchor !== undefined) {
        const content = await readFile(target, "utf8");
        const headings = [...withoutCode(content).matchAll(/^#{1,6}\s+(.+)$/gm)]
          .map((heading) => headingId(heading[1]!));
        assert.ok(headings.includes(anchor), `${name}: missing heading ${link}`);
      }
    }
  }
  assert.deepEqual((await readdir(output)).sort(), [...files].sort(), "Unexpected/missing staging assets");
  for (const name of files) await requireRegular(join(output, name));
  const markdown = new Map<string, string>();
  for (const name of [...pages, "_sidebar.md"]) markdown.set(name, await readFile(join(output, name), "utf8"));
  for (const [name, content] of markdown) {
    for (const match of withoutCode(content).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1]!;
      if (/^https:\/\//.test(link)) continue;
      const [file, anchor] = link.split("#");
      const target = file === "" ? name : file!;
      assert.ok(markdown.has(target), `${name}: invalid local link ${link}`);
      if (anchor !== undefined) {
        const headings = [...withoutCode(markdown.get(target)!).matchAll(/^#{1,6}\s+(.+)$/gm)]
          .map((heading) => headingId(heading[1]!));
        assert.ok(headings.includes(anchor), `${name}: missing heading ${link}`);
      }
    }
  }
  const sidebar = [...markdown.get("_sidebar.md")!.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert.deepEqual(sidebar, pages, "Keep the documented reading order");
  const index = await readFile(join(output, "index.html"), "utf8");
  const assets = [...index.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(assets, [
    "https://cdn.jsdelivr.net/npm/docsify@5.0.0/dist/themes/core.min.css",
    "https://cdn.jsdelivr.net/npm/docsify@5.0.0/dist/docsify.min.js",
    "https://cdn.jsdelivr.net/npm/prismjs@1.30.0/components/prism-typescript.min.js",
    "https://cdn.jsdelivr.net/npm/docsify@5.0.0/dist/plugins/search.min.js",
  ], "Only pinned docs assets may load");
  assert.match(index, /routerMode: 'hash'/);
  assert.match(index, /executeScript: false/);

  const quickStart = markdown.get("quick-start.md")!;
  const snippet = /<!-- checked-counter:start -->\s*```ts\n([\s\S]*?)\n```\s*<!-- checked-counter:end -->/.exec(quickStart);
  assert.ok(snippet, "Missing complete checked Counter snippet");
  const expected = /Expected output:\s*```text\n([\s\S]*?)\n```/.exec(quickStart);
  assert.ok(expected, "Missing expected Counter output");
  const temporary = await mkdtemp(join(output, ".counter-"));
  try {
    // Inside the checkout only for self-package resolution; no source imports or paths aliases.
    const filename = join(temporary, "counter.ts");
    await writeFile(filename, snippet[1]!);
    const require = createRequire(import.meta.url);
    const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
    await execute(process.execPath, [compiler, "--ignoreConfig", "--noEmit", "--strict",
      "--target", "ES2024", "--module", "NodeNext", "--moduleResolution", "NodeNext", filename],
    { cwd: root, timeout: 15_000 });
    const result = await execute(process.execPath, ["--unhandled-rejections=strict", filename], { cwd: root, timeout: 15_000 });
    assert.equal(result.stdout.trimEnd(), expected[1]);
    assert.equal(result.stderr, "");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const host = await serveDocs(0);
  try {
    for (const [path, method, status] of [
      ["", "GET", 200], ["_sidebar.md", "GET", 200],
      ["quick-start.md", "HEAD", 200], ["index.html", "POST", 405],
      ["development.md", "GET", 404], ["examples.md", "GET", 404],
      ["CONTRIBUTING.md", "GET", 404],
      ["src/index.ts", "GET", 404], ["../package.json", "GET", 404],
      ["%2e%2e/.git/config", "GET", 404],
    ] as const) {
      const response = await fetch(new URL(path, host.url), { method, signal: AbortSignal.timeout(5_000) });
      const body = await response.text();
      assert.equal(response.status, status, `${method} ${path}`);
      if (method === "HEAD") assert.equal(body, "");
      if (status === 200) assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    }
  } finally {
    await host.close();
  }
  console.log("Docs links, HTTP asset boundaries and Counter typecheck/runtime passed");
}

/** Local project-site preview: fixed allowlist, no directory traversal or checkout serving. */
export async function serveDocs(port = 5566) {
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, "Invalid preview port");
  await buildDocs();
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const name of files) {
    await requireRegular(join(output, name));
    assets.set(prefix + name, { body: await readFile(join(output, name)),
      type: name.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" });
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/articollab" || path === "/") {
      response.writeHead(302, { Location: prefix }); response.end(); return;
    }
    const asset = assets.get(path === prefix ? prefix + "index.html" : path);
    if (asset === undefined) { response.writeHead(404); response.end("Not found"); return; }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }); response.end("Method not allowed"); return;
    }
    response.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? undefined : asset.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}${prefix}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
      server.closeAllConnections();
    }) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2];
  if (action === "build" && process.argv.length === 3) await buildDocs();
  else if (action === "check" && process.argv.length === 3) await checkDocs();
  else if (action === "serve" && process.argv.length <= 4) {
    const host = await serveDocs(process.argv[3] === undefined ? undefined : Number(process.argv[3]));
    console.log("Open " + host.url + " in your browser. Press Ctrl+C to close.");
    const stop = () => {
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      host.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
    };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  } else throw new Error("Usage: node scripts/docs.ts build|check|serve [port]");
}
