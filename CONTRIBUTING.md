# Contributing

This guide is for working on the repository: checking changes, writing docs and cutting releases. To use the library, start with the [quick start](docs/quick-start.md).

## Set up

Use Node.js 26 (see `.nvmrc`) and pnpm 12.15.0 (see `packageManager`). The published package supports Node.js 24 and later, and CI also runs the main checks on Node.js 24.

```sh
pnpm install --frozen-lockfile
pnpm build
```

Build before anything that loads `dist`: the examples, browser tests and the docs check.

## Check your changes

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

- `pnpm test` builds once, then runs the suites. When you run one file with `node --test`, build first yourself: it does not rebuild `dist`.
- `pnpm test:package` packs the library, installs it into a temporary project and checks its runtime and types there. It publishes nothing.
- Lint warnings, unused lint exceptions and Knip findings all fail. Keep any lint exception next to the line it covers, with a reason.
- Knip also checks exports. Public entrypoint exports are API even if nothing in the repository calls them.

Each example is its own project and has its own checks. CI runs them after building the library:

```sh
pnpm --dir examples/text-editor install --frozen-lockfile --ignore-scripts
pnpm --dir examples/text-editor check
pnpm --dir examples/text-editor lint
pnpm --dir examples/text-editor knip
pnpm --dir examples/text-editor test
```

Run the same install and four checks for `examples/rich-editor`, and the four checks for `examples/kanban` and `examples/file-tree` (they need no install). Tests cannot replace trying the [examples](examples/README.md) in a browser.

### Find the relevant tests

- Collections, transactions and callbacks: `runtime.test.ts`, `list.test.ts`, `text.test.ts`, `text-marks.test.ts`, `map.test.ts`, `counter.test.ts`.
- Wire decoding, checkpoints, history and retries: `wire.test.ts`, `client-checkpoint.test.ts`, `history.test.ts`, `retry.test.ts` and the `*-resume` suites.
- Undo, outcomes and events: `undo.test.ts`, `settled.test.ts`, `transform-event.test.ts`, `discard.test.ts`.
- Sync: the `sync-*` suites, including `sync-websocket.test.ts`.
- Change events: `reconciliation-change.test.ts` compares every server change event with a full comparison of the visible state.

Interleaving tests are seeded. To repeat one seed:

```sh
node --test --test-name-pattern="seed=42" test/interleaving.test.ts
```

## Write documentation

```sh
pnpm build
pnpm docs:build
pnpm docs:check
pnpm docs:serve
```

Open `http://127.0.0.1:5566/articollab/`, or run `pnpm docs:serve 0` for any free port. Restart the preview after editing. `docs:check` checks links and anchors, and it type-checks and runs the quick start example against the built package.

User pages live in `docs/`; this guide is not published. When writing them:

- Give each page one job: teach a task, explain an idea or list exact rules. Exact rules belong in the reference.
- Show an example, then say what it did.
- Use short sentences and plain words. Define a term before using it.
- Put a limit next to the action it limits.
- Leave out progress reports, test counts and release status.

In install instructions, use `pnpm add articollab`. Mention a version only in upgrade guidance.

## Benchmarks

The benchmark builds the package and runs each workload in its own worker process. Save JSON results outside the repository, and compare two runs on the same machine before drawing conclusions. There is no latency target in CI.

| Command | Measures |
| --- | --- |
| `pnpm bench` | Local edits, sync, receive, snapshots and heap for List and Text at 1,000 to 50,000 elements |
| `pnpm bench --list-move` | Moving an element locally and receiving the move, with and without an observer |
| `pnpm bench --extended` | Fragmented Text up to 100,000 code points, and server submission with large history |
| `pnpm bench --checkpoint-storage` | Server checkpoint size and save/restore time as JSON, gzip and Brotli |
| `pnpm bench --profile-remote-replace <dir>` | CPU profiles of receiving a remote Text replacement, written to an existing directory |

Add `--smoke` for a quick run with tiny fixtures, or `--json` (with `pnpm --silent`) for machine-readable output.

## Maintain the vendored map and reconciliation shortcuts

`src/vendor/hamt.ts` is a typed subset of [hamt_plus](https://github.com/mattbierner/hamt_plus) at `b8845c7343fdde3966f875d732248fec597cf538`. Keep its source revision, adaptations and MIT notice. When you update it, run `hamt.test.ts` and compare benchmarks, including heap.

`receive()` skips full comparisons in a few safe cases; each is commented in `src/runtime.ts`. They rely on these facts:

- Replay records fixed IDs, deletes keep tombstones, and nothing undeletes or replays an intent.
- With no replay conflict on either side, only the commit's target IDs can change what is visible.
- One remote move with no pending work changes only the moved element's position.
- An element's marks depend only on the mark list and known order. With equal mark lists, only inserted elements need their marks read; with equal content, only elements inside marks that one side lacks. Any Text mark or paragraph attribute in a commit makes that Text compare in full, and so do different paragraph attribute maps. A state made from another by paragraph attribute changes alone remembers which paragraphs changed, so comparing the two reads only those.

Adding undelete, same-ID Text replacement or intent-based replay breaks these facts: revisit the shortcuts first. After changing one, run `reconciliation-change.test.ts`, the observe tests and the receive benchmarks.

## CI

| Workflow | Runs on |
| --- | --- |
| [CI](.github/workflows/verify.yml) | Pushes to `main`, pull requests and manual runs |
| [Validation](.github/workflows/checks.yml) | Called by CI and Release: all checks above, plus Node.js 24 |
| [Deploy documentation](.github/workflows/docs.yml) | Called by CI on `main` when `PAGES_ENABLED=true` |
| [Release](.github/workflows/ci.yml) | Pushed `v*` tags. Keep this file name: npm trusts `ci.yml`. |

Approve workflow runs from forks only after reviewing them. For the docs site, set Pages to deploy from GitHub Actions and set `PAGES_ENABLED=true`.

## Release

1. **Prepare.** Start from a clean `main` that matches `origin/main`, with tags fetched. Run all checks above and check [Upgrading](docs/upgrading.md) covers every change to saved formats or APIs.
2. **Preview.** `pnpm release --release-as <version> --dry-run` shows the version, CHANGELOG and tag. It changes nothing.
3. **Write the version and CHANGELOG without committing.**

   ```sh
   pnpm release --release-as <version> --skip.commit --skip.tag
   ```

   The generated CHANGELOG lists only commits marked as breaking (`!` or `BREAKING CHANGE:`) under BREAKING CHANGES. Add any other breaking change by hand, and fix entries whose wording is out of date.
4. **Commit and tag, signed.**

   ```sh
   git commit -S -am "chore(release): <version>"
   git tag -s v<version> -m "v<version>"
   ```

5. **Push `main`, wait for CI, then push only the tag.** Do not use `--follow-tags`.

   ```sh
   git push origin main
   git push origin v<version>
   ```

Pushing the tag starts the Release workflow. It publishes to npm through trusted publishing (OIDC): `vX.Y.Z` goes to `latest` and `vX.Y.Z-beta.N` to `beta`. The tag must match the `package.json` version and point into `main`.

If publishing fails or its verification times out, check the registry before doing anything. The upload may have succeeded. Never rerun the publish job, overwrite a published version or move its tag.
