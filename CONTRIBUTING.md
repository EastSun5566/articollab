# Contributing

Use this guide to modify the repository, verify changes and prepare releases. Contributor tooling and demos require a checkout and are not shipped in the npm package. For library usage, start with the [Counter quick start](docs/quick-start.md).

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

The [text editor prototype](examples/README.md#text-editor-prototype) is an independent private project. Root type/lint/unused checks exclude only `examples/text-editor/`; CI separately installs its frozen lockfile and runs every gate below after building the core:

```sh
pnpm --dir examples/text-editor install --frozen-lockfile --ignore-scripts
pnpm --dir examples/text-editor check
pnpm --dir examples/text-editor lint
pnpm --dir examples/text-editor knip
pnpm --dir examples/text-editor test
```

Its scripts borrow the root's installed tools. The three exact Knip binary exceptions (`tsc`, `oxlint`, `knip`) refer to those parent tools, not unchecked dependencies. Keep the independent gates when changing the root exclusions. Native browser JS uses JSDoc with its own strict typecheck; it is not covered by the older browser smoke command.

### Find the relevant tests

Collection, transaction and callback contracts are covered by `runtime.test.ts`, `list.test.ts` and `text.test.ts`. Session/namespace tests cover writer boundaries; wire/checkpoint/history/retry suites cover decoding and recovery. Integration suites cover HTTP, persistence and browser orchestration. These are pointers, not proof of complete coverage.

`reconciliation-change.test.ts` checks server change events against a full comparison of visible IDs, payload references and conflict descriptors, including deterministic seeds. It rebuilds the pending prefix with existing hydration/replay code, but does not call runtime equality helpers. This is an oracle for change detection, not an independent List/Text ordering model.

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

General installation instructions use `pnpm add articollab`, which selects the `latest` release. Use `articollab@beta` only for prereleases. Keep concrete versions in upgrade guidance only when necessary. Dist-tags select an install-time version; they do not continuously upgrade an installed project.

## Benchmark and vendor maintenance

```sh
pnpm bench
pnpm --silent bench --json
pnpm bench --smoke
```

The benchmark builds production ESM and uses the public entrypoint. It measures List/Text at 1,000, 10,000 and 50,000 elements/code points in separate worker processes. Primitive fixtures start with `"x"`; insertions use List `"y"` or Text `"😀"`. History is disabled. Networking, wire decoding, filesystem persistence and client churn are outside the timed work.

Workloads cover local edits, in-process sync, remote receive with 20 pending insertions, materialization, snapshots, unused policy snapshots, unchanged receive and retained heap. Heap measures one hydrated client, not peak memory, allocation rate or RSS. Snapshot/checkpoint UTF-8 JSON bytes are reported separately.

Seven List workloads use `{ label: "x" }` elements. JSON-decoded insertion ack, in-memory replacement ack, JSON-decoded replacement ack and remote replacement time only `receive()`; local edits, submission, serialization/decoding and assertions are outside the timer. Set workloads measure local `set()` (submission/ack excluded), JSON-decoded set ack and remote set receive. All replacements/sets target the last element. These are single-bunch fixtures, not fragmented-document measurements.

Eight more receive-only scenarios cover remote List set/replacement and Text replacement with 20 pending batches, on either the same path or a disjoint Value path; two mixed own-ack scenarios combine Text with a List object or Value object. Same-path pending work inserts at the end; disjoint pending work makes 20 Value writes. All commits cross JSON decoding before timing. Mixed schemas put Text first so another collection's change cannot hide a Text scan. Trials check final values, server events, pending payloads, watermarks and allocation progress outside timing. The full matrix contains 99 workloads and smoke contains 33; the original 75 keep their measurement boundaries.

Each worker has a 30-second timeout, one warm-up and five fresh-fixture samples. Timing averages ten operations per sample, except pending replay's single receive. Setup, explicit GC and assertions are excluded; natural GC during operations is included. Heap uses explicit GC before/after hydration and retains signed deltas, including negative measurements. Smoke uses size 32, two samples and two operations, still with 20 pending batches.

JSON includes raw samples, settings, Node/V8, system information, versions and Git SHA/dirty status. Save results outside the checkout. Compare repeated runs on the same machine, Node version and workload without unrelated load; five samples do not support p95 claims. There is no CI latency threshold, SLA or browser-performance promise.

### Fragmented Text and bounded history

The opt-in extended matrix is separate from the default 99 workloads:

```sh
pnpm bench --extended
pnpm --silent bench --extended --json
pnpm bench --extended --smoke
```

Text fixtures use seed 42 with unsigned 32-bit xorshift (13, 17, 5). Public API transactions insert `size + floor(size / 4)` code points at random positions, then delete `floor(size / 4)` random visible points. Every eleventh insertion is `"😀"`; the others are `"x"`. Both transactions are acknowledged before measurement, and an independent code-point array verifies the result. Reports include visible/deleted ID counts, saved ranges, distinct bunches and the snapshot SHA-256. This is one deterministic editing pattern, not a claim to model every workload.

The full matrix has 31 workloads: nine Text scenarios at 10,000, 50,000 and 100,000 visible code points, plus server submission at history capacities 0, 1,000, 10,000 and 100,000. Each worker prepares its fixture once; every trial starts with fresh documents from the same snapshot/checkpoint. Workers run sequentially with a fixed 120-second timeout (original workers remain at 30 seconds); failures are not retried.

Text scenarios measure local single insert/delete, local deletion of the first half (including range construction), receive-only remote last-code-point replacement, receive-only deletion of a known tombstone, overlapping remote insert with 20 pending end insertions, client/server decode + restore, and one restored client's retained heap. Remote replacement alternates `"R"`/`"S"`; pending replay inserts `"R"` at the start remotely and preserves the local `"P"` suffix. History uses small Value batches with no client delivery: prefill with history disabled, then restore the full legal suffix at the target capacity before timing new submissions.

Each worker uses one warm-up and five samples. Bulk deletion, pending replay, restore and heap have one operation per sample; other timings average ten. Smoke has 13 workloads: Text size 32 and history capacities 0, 2, 4 and 8, with two samples and two operations for repeated timings. Smoke tests compare fixture fingerprints across two runs, never time or heap equality.

Fixture generation, trial setup, assertions, explicit GC and serialization are outside timing. Decode + restore includes the public decoder and constructor but excludes `JSON.parse`; it is not pure hydration. Local edits do not submit/ack, and receive-only scenarios exclude server submission. JSON byte counts describe the prepared snapshot/server checkpoint, not post-trial output or compression. Heap is the signed post-GC delta for a restored client above its already-parsed input, not peak memory or RSS. Keep raw full-run results outside the checkout and compare two runs before proposing storage or reconciliation changes.

### Receive-only Text CPU profiles

Use an existing directory outside the checkout. Each invocation creates a unique child directory without overwriting previous artifacts:

```sh
pnpm bench --profile-remote-replace <existing-output-directory>
pnpm bench --profile-remote-replace <existing-output-directory> --smoke --json
```

This mode cannot be combined with `--extended`. It reuses the fragmented fixtures and remote tail replacement assertions above. For each size (10,000, 50,000 and 100,000), a control worker runs first with no profiler, followed by a separate profiled worker. Both use one warm-up, five fresh-document samples and ten receives per sample. Smoke uses size 32, two samples and two receives. Each worker has the same fixed 120-second timeout; no failure is retried. All workers run sequentially.

The profiler uses a local `node:inspector/promises` session with a 1,000-microsecond sampling interval; it does not open a debugger port. Setup, server submission, commit preparation and explicit GC finish before profiling starts. Only the synchronous receive loop is measured; the profiler stops before assertions, summaries or file output. Session cleanup preserves the first failure. Profiler start/stop overhead may still appear in samples, so profiled wall times are reported separately from controls.

`manifest.json` records environment, SHA/dirty status, settings, fixture fingerprints and artifact paths. Each sample has a raw `.cpuprofile` and `.summary.json`; `control-<size>.json` preserves the unprofiled samples. JSON stdout is only the manifest; human output points to the artifact directory. Failures stop the run and retain completed artifacts (and worker errors when writable), rather than pretending to produce a complete manifest.

Summary times weight samples by their microsecond deltas; these are estimates, not exact CPU time. Exclusive groups separate authoritative apply, visible Text equality, other runtime work, GC and profiler/unattributed work. Within equality, recognizable leaf frames are assigned to ID iteration, key encoding or HAMT lookup; the remainder stays `other`. Function rows report self and inclusive estimates by name, URL and source position. Inclusive costs overlap and must not be added. Inlined functions and unrecognized/native frames cannot always be attributed; inspect the raw call tree before choosing an optimization. Small smoke runs may have too few samples to identify a hotspot, and tests do not require any particular attribution or latency.

Keep artifacts outside Git. For a focused repeat, build first, create a fresh external output directory and use the same private workers: `node --expose-gc scripts/bench.ts --extended-worker text 100000 remote-replace full` for the control, then `node --expose-gc scripts/bench.ts --profile-worker 100000 full <existing-output-directory>` for profiles. Capture control stdout and environment/SHA alongside them. These internal entrypoints have no compatibility guarantee; do not run a second profile worker into the same directory. Full-process `--cpu-prof` is not equivalent: it includes fixture generation and restore.

### Vendor and reconciliation maintenance

List/Text payload storage vendors a typed string-key subset of [hamt_plus](https://github.com/mattbierner/hamt_plus) at `b8845c7343fdde3966f875d732248fec597cf538`. Keep the source revision, adaptations and full MIT notice intact through packing. Payloads retain references; `Object.is` preserves signed zero. Transient drafts stay within synchronous, finally-scoped callbacks; IdList defines visible order and tombstones.

For vendor upgrades, review adaptations, run collision/version-isolation regressions and compare benchmarks, including retained heap. Persistent storage avoids whole-Map copies, not every linear scan or worst-case hash collision.

Local Value/List JSON validation visits the supplied payload without a copy or cache; measure large-payload replacement separately from primitive-element collection benchmarks. Reconciliation optimizations must preserve ordered validation, visible equality, conflict and notification contracts. Neither improvement establishes constant-time receive.

Conflict-free own acks may differ in Value or List insert/set payloads while retaining the same operation order, paths, IDs, anchors, Text strings and ranges. Value still uses `Object.is`; List compares values at the affected stable IDs. Text is unchanged because its operations match exactly and other collections' payloads cannot affect it. Authoritative application and pending replay still run, decoded references are adopted, and hidden payload changes remain silent. Different operation structure or a conflict on either side retains full comparison. Use the change oracle and mixed receive workloads when modifying this shortcut.

Remote commits with no replay conflict before or after reconciliation compare final optimistic visibility and values at List insert/delete/set targets and Text insertion/deletion ranges, even with pending work. Replay records fixed IDs, deletion retains tombstones, and there is no move, undelete or payload-dependent mutator. When both complete pending sequences replay successfully, removing the commit's target IDs leaves the same visible ID order and payload references on both sides. A pending set/delete may hide a remote effect, so compare the replayed states, not just the incoming payloads. Disjoint pending paths keep their existing states; overlapping paths still replay in full. A conflict on either side requires the existing full comparison because the replayable prefix may change across paths.

Text ranges are visited lazily without expanding ID arrays, and comparison stops at the first difference. List payloads retain `Object.is` equality. Text compares code points and visible IDs: replacing text with identical characters but new IDs is still a change. An insertion deleted within the same commit or a delete/set to a known tombstone stays silent. Full authoritative validation still precedes comparison. Revisit the proof before adding move, undelete, same-ID Text replacement or intent-based replay. Use the full change oracle, pending receive workloads and fragmented receive-only profiles when changing these shortcuts; affected-target cost does not make authoritative apply or pending replay constant-time.

Decoded List/Text snapshots reuse the persistent states loaded during validation. This cache is keyed only by decoder-owned frozen payloads; raw typed snapshots still load and validate normally. Constructors decode checkpoints again, so reuse is within each decoding boundary, not across every decode/restore call. Retaining a decoded snapshot also retains its cached state; measure that memory tradeoff when changing hydration.

Text observers keep a separate persistent-state baseline per subscriber. For local operations and conflict-free remote commits, removing all accumulated target IDs leaves the same ordered, unchanged elements on both sides. Sort the targets' old/new positions, skip untouched gaps and replace adjacent target runs; discard element-identical replacements. Equal-length edits with unequal insertion/deletion counts across separate regions require a full element-prefix/suffix comparison: changed IDs can merely redistribute repeated characters without changing content. Coalescing uses the union of targets until all subscriber baselines catch up. Conflicts on either side and structurally transformed/rejected own batches also use the full fallback. Diff the optimistic views, never just the authoritative operations. Revisit this proof for move, undelete or intent-based replay.

`text-observe.test.ts` applies notifications to independent element-array mirrors, including seeded interleavings, surrogate boundaries, callback failures and reentrancy. Observer baselines advance before callbacks, and notification draining runs only after existing callbacks succeed. Preserve their failure ordering when changing notification scopes. Unsubscribed Text must do no target traversal or diff calculation; do not charge all clients for opt-in UI integration. Full fallback and array/string materialization remain linear costs.

## CI and documentation deployment

The `CI` workflow checks main pushes, `v*` tag pushes, PRs to main and manual runs. It uses a frozen install, pinned actions and the declared pnpm, then runs checks including browser JSDoc, package consumers and docs staging. Local success does not prove remote success.

Repository visibility, contribution settings and Pages deployment are separate decisions. Before making a repository public, review its full Git history, author metadata, pull requests, workflow logs and artifacts for information that should not be exposed.

When accepting public contributions, check these repository settings:

- Protect `main` with required CI checks, and block force pushes and branch deletion. Review changes before merging, especially workflow and release changes.
- Require workflow approval for all outside collaborators. [Inspect the proposed code before approving a fork workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks), not just before merging it.
- Keep default workflow permissions read-only and automatic PR approval disabled. Do not give fork checks secrets or publishing/deployment credentials.

Pages upload/deployment requires successful checks, a main push/manual event and `PAGES_ENABLED=true`. Only validated `.docs-site/` is uploaded. The deploy job alone receives Pages write/OIDC permissions; `enablement: false` does not enable Pages automatically. PRs and tag runs do not deploy docs.

Before enabling Pages, review the staged assets, select GitHub Actions as the repository's [Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), then set `PAGES_ENABLED=true`. After deployment, verify its commit, URL and rendered behavior; changing repository visibility alone does not deploy the site.

## Prepare and publish a release

### Confirm readiness

Fetch main and tags, then confirm a clean `main` synchronized with `origin/main`. Review compatibility/upgrade guidance, run the checks above and full browser JSDoc, and inspect the packed manifest, exports, allowlist and vendor MIT notice. Tooling and this guide remain outside the tarball.

Choose an explicit unpublished target version. In the commands below, replace `<target-version>` and `<release-tag>`; they are placeholders, not literal shell arguments. Beta tags are `vX.Y.Z-beta.N`; stable tags are `vX.Y.Z`.

Review the [Recovery upgrade guides](docs/recovery.md#upgrading-from-03-to-04) for coordinated runtime upgrades and checkpoint compatibility before choosing a release target. Include all snapshot/checkpoint readers, not just batch/commit participants, when a release extends the saved format.

```sh
pnpm release --release-as <target-version> --dry-run
```

Review the expected version, changelog and tag. Dry-run must not modify tracked files, HEAD or tags.

### Review a beta-to-stable promotion

Compare the candidate with the previous stable release, not just the latest beta:

- Review API and wire changes, including operations retained in pending batches, retry results and history. Check upgrade instructions against the existing collection and recovery tests. Read the full commit range too: the default changelog can omit performance, test and documentation commits.
- Confirm what remains compatible for the same schema/document lineage and where rollback requires application planning. Keep transport, storage, authentication and writer coordination as application responsibilities.
- Verify the installed package's runtime/declarations and inspect its manifest, production file allowlist and complete vendor notices. Performance measurements are evidence for specific workloads, not compatibility or latency guarantees.

For a stable target, dry-run the inspected tarball with an explicit channel override:

```sh
npm publish <tarball> --dry-run --ignore-scripts --tag latest --access public --registry=https://registry.npmjs.org/
```

Replace `<tarball>` with its actual path. This validates packaging, not OIDC authentication, and uploads nothing. A tarball packed before the real release carries the current manifest version, not the dry-run target; rebuild, repack and verify the final version after the signed release. Do not call the target version published or update installation guidance to claim publication until the registry confirms it. Actual publication remains the tag workflow below.

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

The publish job receives publishing OIDC permission; the checks job does not. It uses the workflow's pinned npm on a GitHub-hosted runner, not npm tokens or login. Main/PR/manual runs never publish.

After checks, the publish job builds and packs one tarball outside the checkout, dry-runs it, then publishes that file with explicit registry, public access, channel and disabled lifecycle scripts. Tag runs are not automatically cancelled.

npm may accept an upload before the version becomes publicly available. Registry verification checks version, dist-tag and SHA-512 with at most 24 online reads, 15 seconds apart with 15-second request timeouts. The publish job has a 15-minute limit to allow verification plus setup and publishing. Only a missing version or stale dist-tag is retried; other errors fail. Publication itself is never retried.

If verification times out, public availability is unconfirmed, not proof that the upload failed. Check the registry again without republishing. Do not rerun the publish job just to repeat verification: it would attempt another upload.

A failed response may still mean publication completed. Inspect the registry before taking action; do not bump automatically, overwrite a published version or move its tag. Local dry-run is not evidence that OIDC publishing works.
