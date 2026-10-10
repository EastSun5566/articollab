# Contributing

Use this guide to modify the repository, verify changes and prepare releases. Repository access is required; contributor tooling and demos are not shipped in the npm package. For library usage, start with the [Counter quick start](docs/quick-start.md).

## Set up a checkout

Use Node.js 24+ and pnpm `10.34.5`, as declared in `packageManager`. The project uses TypeScript 7's standard `tsc`.

```sh
pnpm install --frozen-lockfile
pnpm build
```

Build production ESM before checks that resolve `dist`, including browser JS lint/JSDoc and documentation snippets. Production builds include only `src`.

## Verify changes

```sh
pnpm build
pnpm lint
pnpm knip
pnpm check
pnpm test
pnpm test:package
pnpm docs:build
pnpm docs:check
git diff --check
```

Native Node tests run TypeScript directly. `pnpm test` and `pnpm test:coverage` build once, then run at most two test files concurrently. Suites do not rebuild shared `dist`; a build failure stops the test command.

For focused browser or benchmark tests, build first, including after changing source. Direct `node --test` does not check artifact freshness:

```sh
pnpm build
node --unhandled-rejections=strict --test test/browser-server-recovery.test.ts
node --unhandled-rejections=strict --test test/benchmark.test.ts
```

`test:package` separately builds/packs and installs into a temporary ESM consumer. It verifies tarball contents, runtime and strict declarations with `skipLibCheck: false`, using the checkout's installed TypeScript/Node types versions. Installation disables scripts, may need registry access and cleans up consumers. It publishes nothing.

Oxlint uses type-aware correctness/suspicious, explicit-any and unsafe-value checks. Warnings and unused disable directives fail. Keep exceptions local and justified; the test-registration exception does not disable other Promise checks. TypeScript and browser JSDoc remain independent gates.

Knip covers source, tests, scripts and examples; findings and configuration hints fail. Public entrypoint exports are intentional APIs, not candidates for removal merely because the checkout does not call them. Review findings before deleting code.

### Find the relevant tests

Collection, transaction and callback contracts are covered by `runtime.test.ts`, `list.test.ts` and `text.test.ts`. Session/namespace tests cover writer boundaries; wire/checkpoint/history/retry suites cover decoding and recovery. Integration suites cover HTTP, persistence and browser orchestration. These are pointers, not proof of complete coverage.

Reproduce a deterministic scheduling seed with:

```sh
node --test --test-name-pattern="seed=42" test/interleaving.test.ts
```

Browser JSDoc and Node integration tests do not replace interactive verification. The [examples guide](examples/README.md#browser-reload-recovery-example) includes the full JSDoc command and manual demo steps. Keep tooling-specific instructions out of user documentation.

## Preview and write documentation

```sh
pnpm build
pnpm docs:build
pnpm docs:check
pnpm docs:serve
```

Open `http://127.0.0.1:5566/articollab/`, or use `pnpm docs:serve 0` for an automatic port. The preview snapshots assets at startup; restart it after editing. Hash routes preserve deep links under the project-site prefix. CDN rendering needs network access.

User pages live in `docs/`. Staging copies only the fixed public allowlist; it does not publish this guide or generate pages from the root README or repo demo guide. Checks verify source/staged links, anchors, HTTP asset boundaries, pinned CDN assets and the exact Counter snippet against built ESM/declarations.

Keep user guidance separate from repository operations:

- Give each page one purpose: teach a task, explain a concept or provide a reference.
- Introduce an example's context, show the action, then explain its result.
- Use direct, factual language, short paragraphs and defined terminology.
- Place relevant limits beside the action; preserve exact contracts in Reference.
- Avoid progress reports, test counts, release status repetition and unnecessary jargon.

These principles follow the [Astro writing guide](https://contribute.docs.astro.build/guides/writing-style/) and [Vercel writing guidelines](https://raw.githubusercontent.com/vercel-labs/writing-guidelines/main/command.md), without adopting their product-specific components.

General installation instructions use `articollab@beta` while releases use the beta channel. Keep concrete versions in upgrade guidance only when necessary. Dist-tags select an install-time version; they do not continuously upgrade an installed project.

## Benchmark and vendor maintenance

```sh
pnpm bench
pnpm --silent bench --json
pnpm bench --smoke
```

The benchmark builds production ESM and uses the public entrypoint. It measures List/Text at 1,000, 10,000 and 50,000 elements/code points in separate worker processes. Fixtures start with `"x"`; insertions use List `"y"` or Text `"😀"`. History is disabled. Networking, wire decoding, filesystem persistence and client churn are outside these measurements.

Workloads cover local edits, in-process sync, remote receive with 20 pending insertions, materialization, snapshots, unused policy snapshots, unchanged receive and retained heap. Heap measures one hydrated client, not peak memory, allocation rate or RSS. Snapshot/checkpoint UTF-8 JSON bytes are reported separately.

Each worker has a 30-second timeout, one warm-up and five fresh-fixture samples. Timing averages ten operations per sample, except pending replay's single receive. Setup, explicit GC and assertions are excluded; natural GC during operations is included. Heap uses explicit GC before/after hydration and retains signed deltas, including negative measurements. Smoke uses size 32, two samples and two operations, still with 20 pending batches.

JSON includes raw samples, settings, Node/V8, system information, versions and Git SHA/dirty status. Save results outside the checkout. Compare repeated runs on the same machine, Node version and workload without unrelated load; five samples do not support p95 claims. There is no CI latency threshold, SLA or browser-performance promise.

List/Text payload storage vendors a typed string-key subset of [hamt_plus](https://github.com/mattbierner/hamt_plus) at `b8845c7343fdde3966f875d732248fec597cf538`. Keep the source revision, adaptations and full MIT notice intact through packing. Payloads retain references; `Object.is` preserves signed zero. Transient drafts stay within synchronous, finally-scoped callbacks; IdList defines visible order and tombstones.

For vendor upgrades, review adaptations, run collision/version-isolation regressions and compare benchmarks, including retained heap. Persistent storage avoids whole-Map copies, not every linear scan or worst-case hash collision.

Local Value/List JSON validation visits the supplied payload without a copy or cache; measure large-payload replacement separately from primitive-element collection benchmarks. Reconciliation optimizations must preserve ordered validation, visible equality, conflict and notification contracts. Neither improvement establishes constant-time receive.

## CI and documentation deployment

The `CI` workflow checks main pushes, `v*` tag pushes, PRs to main and manual runs. It uses a frozen install, pinned actions and the declared pnpm, then runs checks including browser JSDoc, package consumers and docs staging. Local success does not prove remote success.

Pages upload/deployment requires successful checks, a main push/manual event and `PAGES_ENABLED=true`. Only validated `.docs-site/` is uploaded. The deploy job alone receives Pages write/OIDC permissions; `enablement: false` does not enable Pages automatically. PRs and tag runs do not deploy docs.

Before enabling Pages, confirm [private-repository support](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) and review published assets. Private source does not imply a private site. After deployment, verify its commit, URL and rendered behavior.

## Prepare and publish a release

### Confirm readiness

Fetch main and tags, then confirm a clean `main` synchronized with `origin/main`. Review compatibility/upgrade guidance, run the checks above and full browser JSDoc, and inspect the packed manifest, exports, allowlist and vendor MIT notice. Tooling and this guide remain outside the tarball.

Choose an explicit unpublished target version. In the commands below, replace `<target-version>` and `<release-tag>`; they are placeholders, not literal shell arguments. Beta tags are `vX.Y.Z-beta.N`; stable tags are `vX.Y.Z`.

```sh
pnpm release --release-as <target-version> --dry-run
```

Review the expected version, changelog and tag. Dry-run must not modify tracked files, HEAD or tags.

### Create the signed release

After approval, use that same version:

```sh
pnpm release --release-as <target-version>
```

The local tool writes the version/CHANGELOG and creates a signed commit and signed `v` tag. It does not push or publish. Consumer tests compare the installed version exactly with the manifest; no separate updater is needed.

The changelog window starts at the previous stable release, not the previous beta. Until a stable tag exists, beta entries are cumulative. Do not use `--first-release`, force/replace tags, bypass signing or blindly rerun after a failure. Inspect partial results first.

### Push main, then its tag

Verify signatures and the release diff/checks, then push main:

```sh
git push origin main
```

Confirm CI succeeds for that release commit before pushing only its specific tag:

```sh
git push origin <release-tag>
```

Ignore the tool's manual publish suggestion. Do not use `--follow-tags`. Preparation, pushing and publication are separate operations.

### Trusted publishing

Tags must match the manifest version and point to main history. CI rejects unsupported prereleases, build metadata and leading-zero components. Beta tags publish to `beta`; stable tags publish to `latest`.

Keep npm's publisher settings aligned with GitHub owner `EastSun5566`, repo `articollab`, workflow `ci.yml`, empty environment, and direct `npm publish` permission. No extra dist-tag management permission is required. The manifest repository URL must match. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

The publish job receives publishing OIDC permission; the checks job does not. It uses the workflow's pinned npm on a GitHub-hosted runner, not npm tokens or login. Private repositories do not generate provenance. Main/PR/manual runs never publish.

After checks, the publish job builds and packs one tarball outside the checkout, dry-runs it, then publishes that file with explicit registry, public access, channel and disabled lifecycle scripts. Tag runs are not automatically cancelled.

Registry verification checks version, dist-tag and SHA-512. It makes at most 12 online reads, 15 seconds apart with 15-second timeouts. Only a missing version or stale dist-tag is retried; other errors fail. Publication itself is never retried.

A failed response may still mean publication completed. Inspect the registry before taking action; do not bump automatically, overwrite a published version or move its tag. Local dry-run is not evidence that OIDC publishing works.
