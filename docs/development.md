# Development

Use this guide to work on a repository checkout, run verification and preview the documentation. Repository access is required; installing the npm package does not include these tools or examples.

## Verification

Requires Node.js 24 or newer, pnpm `10.34.5` from `packageManager`, and TypeScript 7's standard `tsc`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm lint
pnpm knip
pnpm test:package
```

Native Node tests run TypeScript directly; production builds emit only `src` into `dist`. `pnpm test` and `pnpm test:coverage` build production code once before starting the runner, then execute at most two test files concurrently. Suites do not rebuild the shared `dist`; file-level isolation and existing protocol interleaving tests remain unchanged. Build failure stops execution before tests start.

For focused browser or benchmark tests, run `pnpm build` first, including after changing source. Direct `node --test` does not build or check whether `dist` is current:

```sh
pnpm build
node --unhandled-rejections=strict --test test/browser-server-recovery.test.ts
node --unhandled-rejections=strict --test test/benchmark.test.ts
```

`test:package` is separate from `test`: it still builds/packs a local tarball and installs it in a fresh temporary ESM consumer, checking package contents, runtime and independent strict NodeNext declarations (`skipLibCheck: false`). Consumer installation uses the checkout's exact installed TypeScript/Node types versions, disables install scripts and may need registry access. Nothing is published; temporary consumers are cleaned up. `pnpm bench` also keeps its own production build.

`pnpm lint` uses lockfile-pinned Oxlint/tsgolint with caret ranges in the manifest, type-aware TypeScript/Oxc rules, correctness/suspicious errors, explicit-any and unsafe-value checks. Warnings and unused disable directives fail. Pedantic/style/restriction/nursery are not enabled wholesale. Native `node:test` registration calls have a package- and test-source-limited known-safe exception; other promises remain checked. Local exceptions document verified decoder/type bridges, deliberate negative fixtures and Unicode code-point behavior. Build first so browser JS can resolve the production declarations. `tsc` and independent browser JSDoc checking remain separate gates.

`pnpm knip` checks unused files, dependencies and internal exports across source, tests, examples and scripts. Findings and configuration hints fail CI. Public entrypoint exports are intentional package APIs, not deletion candidates just because this checkout does not use them. Browser module entries are explicit; package scripts are discovered automatically. Generated files follow `.gitignore`. Knip is a static check, not proof that all unnecessary code is absent; review findings before removing anything.

The GitHub Actions `CI` workflow runs on main pushes, `v*` tag pushes, PRs targeting main and manual dispatch. One Ubuntu 24.04/Node 24 checks job uses the pinned pnpm, frozen install, check/test/build/lint/Knip, complete browser JSDoc checking, package consumer smoke and docs build/check. There is no dependency cache. Local success is not proof of remote CI success.

| Contract | Existing focused / integration checks |
| --- | --- |
| Collection reads/mutations, Unicode, stable IDs and tombstones | `runtime.test.ts`, `list.test.ts`, `text.test.ts`; browser core smoke |
| Transaction batching, nested/no-savepoint behavior, rollback, local callback failures and reentrant delivery | `runtime.test.ts`, collection tests; `resume.test.ts`, `async-resume.test.ts`, HTTP sync |
| Atomic policy, explicit rejection and original-result retry | Runtime policy tests, `server-reject.test.ts`, `retry.test.ts`; HTTP rejection recovery |
| Explicit writer sessions, open-session capacity, closure and restore | `client-session.test.ts`, `server-capacity.test.ts`; installed runtime/declaration fixtures |
| Opt-in incoming writer/collection namespaces, cross-writer references and unchanged retries | `namespace.test.ts`; installed runtime/declaration fixtures |
| Owned wire JSON and restore metadata | `wire.test.ts`, `client-checkpoint.test.ts`, `history.test.ts` |
| Local JSON validation, unchanged ownership, deep traversal and failure atomicity | `runtime.test.ts`, `list.test.ts`, `wire.test.ts` |
| Pending prefix/conflicts, restore and catch-up | `replay-conflict.test.ts`, `client-checkpoint.test.ts`, `interleaving.test.ts`; HTTP/browser recovery |
| Save-before-send/success and lineage boundaries (application examples) | `persistent-resume.test.ts`, `persistent-http-sync.test.ts`, browser recovery tests, `document-lineage.test.ts` |
| Installed entrypoint and schema-specific declarations | `test/package-consumer/smoke.test.ts`; browser ESM smoke |

These are coverage pointers, not proof of every observable edge case. Dedicated core regression cases in `runtime.test.ts` cover nested transaction batching, escaping-error rollback, caught inner errors without savepoints, and the pending/sequence/notification behavior when local callbacks throw. Existing persistence/recovery tests separately cover callback failures at application boundaries. Do not infer complete coverage from the number of passing tests.

The optional `maxClients` bounds open writer sessions, including those without a batch. `openClient()` allocates a canonical, never-reused ID; `closeClient()` removes its session and last retry. Disconnect and history eviction do not close it. Unknown/closed writers fail before operation copying/policy. Restore validates all session metadata before checking capacity; the allocation counter survives closure and restore. Server checkpoints from 0.1 are intentionally incompatible.

The deterministic interleaving suite uses three clients, five seeds, 200 scheduling steps and repeat-trace comparison, checking protocol invariants, a Value oracle, restore equivalence and convergence—not an independent List/Text model. Reproduce one seed with:

```sh
node --unhandled-rejections=strict --test test/interleaving.test.ts
node --test --test-name-pattern="seed=42" test/interleaving.test.ts
```

Browser JSDoc and Node integration tests do not replace interactive verification. Existing smoke/recovery instructions and the full JSDoc command are in the [examples guide](examples.md).

## Collection performance baseline

Local schema defaults, Value sets and List inserts always validate JSON before mutation. Local validation and wire copy/freeze share the iterative traversal in `src/json.ts`; local validation creates no payload copy and does not freeze the input. It checks each occurrence in the supplied payload without a validation cache, so large Value/List elements have linear traversal cost. Server apply and pending replay do not repeat this local check. Measure large-payload replacement separately from the collection-size benchmark below, which inserts primitive strings. Neither finite numbers nor these checks guarantee lossless JSON serialization of signed zero, enforce later immutability or validate business type shapes.

List/Text values use a typed, string-key subset of [hamt_plus](https://github.com/mattbierner/hamt_plus) vendored at commit `b8845c7343fdde3966f875d732248fec597cf538`. Persistent updates share trie nodes; range edits and hydration use synchronous, finally-scoped transient updates. IdList still determines visible order and tombstones. Payloads are not cloned or converted; value no-op checks use `Object.is` to preserve signed zero. This avoids whole-Map copies, not every linear scan or collision cost.

The source header records local adaptations and the full MIT notice, which must survive production packing. There is no added runtime dependency or public vendor API. Upstream upgrades require reviewing those adaptations, running collision/version-isolation regressions and comparing the full benchmark before and after the change on the same machine and Node version. Bulk drafts must stay inside their synchronous callbacks.

Trie nodes add per-entry memory overhead, so compare retained heap as well as mutation latency. The retained-heap workload measures one hydrated client, not peak memory or the cost of keeping multiple pending versions.

Client reconciliation validates and applies each authoritative commit before considering shortcuts. With no replay conflict, an exact own ack retains the optimistic state without replay or a collection scan; when pending becomes empty, it also shares those confirmed state references with authoritative state. Operation comparison preserves order, IDs, anchors and ranges; Value/List payloads use `Object.is`, not JSON equality, so new object references and signed-zero changes still reconcile normally. A remote commit with paths disjoint from every pending operation keeps unaffected optimistic states without replay. Overlap, transformed/rejected own operations and existing conflicts use full whole-batch replay. Regression tests cover both avoided work and unchanged state, checkpoint and event semantics; these shortcuts do not remove all linear receive costs.

```sh
pnpm bench
pnpm --silent bench --json
pnpm bench --smoke
```

The standalone benchmark builds production ESM and uses only the public `articollab` entrypoint. It measures List and Text separately at 1,000, 10,000 and 50,000 elements/code points. Initial values are `"x"`; List inserts `"y"` and Text inserts the single code point `"😀"`. Fixed snapshot/checkpoint hydration creates the fixtures without thousands of individual writes. Server history is disabled; there is no network, wire decoding, client churn or filesystem persistence in the measured workloads.

| Workload | Measured work |
| --- | --- |
| `local-insert` / `local-delete` | Single-element middle edits; batches remain pending without submission. |
| `sync-insert` | Insert, server receive, writer receive and one peer receive synchronously in one process. Not pure local mutation or network latency. |
| `pending-replay` | Receive one remote Value commit with 20 local insert batches pending; server submission and pending setup are excluded. |
| `materialize` | List `toArray()` or Text `toString()`. |
| `snapshot` | `server.snapshot()`, without JSON serialization. |
| `unused-policy-snapshot` | Server Value mutation with a resolver that never reads snapshot. |
| `unchanged-receive` | Server Value mutation plus client receive while List/Text is unchanged. |
| `retained-heap` | Signed GC-after-hydration heap delta for one live client. An estimate, not peak memory, allocation rate or RSS. |

Cases run sequentially in separate Node processes, with a 30-second timeout per worker. Each case warms up once and collects five samples from fresh fixtures. Timings average ten operations per sample; pending replay performs one receive. Setup, explicit GC and semantic assertions are outside timing, while natural GC during operations remains included. Insert/delete samples evolve the fixture by ten elements. Repeated materialization/snapshot reads use unchanged state. Retained heap uses explicit GC before and after client construction, keeps the client alive through the reading and preserves negative measurements. Initial server snapshot/checkpoint UTF-8 JSON bytes are reported separately, outside timing and heap measurement.

`--smoke` uses size 32, two samples and two operations per sample, still with 20 pending batches. Its tests check the same workloads and semantic invariants, not performance thresholds. The benchmark is not a CI timing gate, and results are not an SLA or a prediction of browser performance.

The table shows median/min/max with units; JSON also includes raw samples, workload settings, Node/V8, OS/architecture/CPU, package/dependency versions and Git SHA/dirty status. For a pure JSON file, redirect `pnpm --silent bench --json` to a caller-chosen location outside the checkout. Nothing is saved automatically or included in the npm tarball. Compare runs on the same machine, Node version and workload, without unrelated load; repeat runs and inspect their spread before judging a regression. Five samples do not justify p95 claims.

## Documentation preview

The tutorial and canonical core reference live in `docs/`. Staging copies those pages and generates only the examples page from `examples/README.md`. No documentation page is generated from the root README.

```sh
pnpm build
pnpm docs:build
pnpm docs:check
pnpm docs:serve
```

Preview at `http://127.0.0.1:5566/articollab/` (or `pnpm docs:serve 0` for an automatic port). The prefix matches the intended Pages project site; hash routes support deep-link reload without server fallback. Preview snapshots the staged assets at startup; restart it after editing. `docs:check` verifies the staged allowlist, local navigation/anchors, pinned CDN assets, and typechecks/runs the exact Counter snippet against built public ESM/declarations. Docs/tooling are not included in the production tarball. CDN-based rendering needs network access.

PRs only validate. Documentation artifact upload and the `deploy-docs` job are gated by repository variable `PAGES_ENABLED=true`, a main push/manual event, and successful checks. The docs deployment job gets `pages: write`/`id-token: write` and the `github-pages` environment; only validated `.docs-site/` is uploaded. Configure Pages uses `enablement: false`. With the variable unset, no upload/deploy occurs. Documentation deployment never enables Pages, changes repository visibility or publishes npm. Tag runs do not deploy docs.

The source repository remains private; the npm beta is public. Before enabling deployment, check [GitHub Pages support for private repositories](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) and review the staged content. A private repository does not make its documentation site private. After deployment, check the workflow commit, site URL and browser behavior; CI checks alone do not verify the rendered site.

## npm release

Release only by pushing a matching version tag after the version commit is on `main`. Tags must be canonical `vX.Y.Z` or `vX.Y.Z-beta.N`, exactly match `package.json`, and point to a commit in `origin/main` history. Other prereleases, build metadata and leading-zero version components are rejected before dependency installation. Beta tags publish to `beta`; stable tags publish to `latest`.

The tag workflow publishes through npm **Trusted publishing**. Keep the package's publisher settings aligned with the workflow:

- Provider: GitHub Actions.
- Organization or user: `EastSun5566`; repository: `articollab`.
- Workflow filename: `ci.yml` (not the full path); environment name: leave empty.
- Allow direct `npm publish`; no additional dist-tag management permission is needed.

The manifest's `repository.url` must match this repository. The workflow uses GitHub-hosted runners and npm `11.21.0`, with `id-token: write` only on the publish job, separate from checks and docs deployment. No npm token, login or approval environment is used. Private source repositories support trusted publishing but do not generate provenance, even for a public package; see [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

Use the local [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) tool to prepare releases. Fetch `origin/main` and tags first, confirm a clean `main` synchronized with `origin/main`, and review compatibility notes and documentation. Always specify the intended version and preview it before making changes:

`0.2.0-beta.0` has been published; do not recreate its tag or republish that version. The commands below use `0.2.0-beta.1` as a future-release example, not authorization to release it. Specify the intended version explicitly rather than asking the tool to infer a bump or adding `--prerelease`. Check the preview's changelog and expected `v0.2.0-beta.1` tag. Dry-run must leave tracked files, HEAD and tags unchanged; it is not release or publish authorization.

```sh
pnpm release --release-as 0.2.0-beta.1 --dry-run
```

After reviewing the preview and authorizing the release:

```sh
pnpm release --release-as 0.2.0-beta.1
```

This writes the chosen version to `package.json`, generates `CHANGELOG.md` from Conventional Commits, and creates a signed release commit and signed `v` tag using the configured GPG key. It does not push or publish. The consumer test compares the installed version exactly with the checkout manifest, so no separate test-version edit or updater is needed. Release tooling and the changelog stay outside the production tarball.

The tool's standard changelog window starts at the previous stable release, not the previous beta. Until there is a stable tag, a beta changelog includes existing core features; those entries are cumulative, not necessarily new in that beta. Do not use `--first-release`, force tags, or replace existing tags. If the tool or signing fails, inspect the partial result before taking further action; do not bypass signing or blindly rerun it.

Verify the release diff, commit/tag signatures and local checks, then push only `main`:

```sh
git push origin main
```

Confirm CI succeeds for that release commit before pushing its specific tag:

```sh
git push origin v0.2.0-beta.1
```

Ignore the tool's suggested manual publish command: pushing the tag starts the existing CI publication flow. Do not use `--follow-tags`, which could push other release tags too. Preparing a release, pushing it, and publishing it are separate steps; previewing or installing this tool does not authorize a release.

The tag runs the full checks before publication. A separate job builds the same commit, packs one tarball outside the checkout, dry-runs it, then publishes that same file with explicit registry, public access and the selected dist-tag. Explicit CLI tags override the manifest's default `beta` tag. Publish lifecycle scripts are disabled; tags are not automatically cancelled by newer runs. PRs, main pushes and manual dispatch never publish.

After publishing, the job verifies registry version, dist-tag and SHA-512 integrity against that tarball. The registry may need time to expose an accepted release: verification performs at most 12 online reads, 15 seconds apart, with a 15-second timeout per read. Only a missing version (`E404`) or a not-yet-updated dist-tag is retried; authentication errors, malformed responses and version/integrity mismatches fail immediately. This never retries publication. Local dry-run is not proof of OIDC authentication or remote publication. An already published name/version fails on rerun; there is no automatic version bump or publish retry. If the publish response or final verification fails, inspect the registry before taking further action: publication may already have completed and cannot be rolled back by the workflow. Do not move old tags or attempt to overwrite a released version.

[Previous: Examples guide](examples.md) · [Next: FAQ and limitations](faq.md)
