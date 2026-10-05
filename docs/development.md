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
pnpm test:package
```

Native Node tests run TypeScript directly; production builds emit only `src` into `dist`. `test:package` is separate from `test`: it builds/packs a local tarball and installs it in a fresh temporary ESM consumer, checking package contents, runtime and independent strict NodeNext declarations (`skipLibCheck: false`). Consumer installation uses the checkout's exact installed TypeScript/Node types versions, disables install scripts and may need registry access. Nothing is published; temporary consumers are cleaned up.

`pnpm lint` uses pinned Oxlint/tsgolint with type-aware TypeScript/Oxc rules, correctness/suspicious errors, explicit-any and unsafe-value checks. Warnings and unused disable directives fail. Pedantic/style/restriction/nursery are not enabled wholesale. Native `node:test` registration calls have a package- and test-source-limited known-safe exception; other promises remain checked. Local exceptions document verified decoder/type bridges, deliberate negative fixtures and Unicode code-point behavior. Build first so browser JS can resolve the production declarations. `tsc` and independent browser JSDoc checking remain separate gates.

The GitHub Actions `CI` workflow runs on main pushes, PRs targeting main and manual dispatch. One Ubuntu 24.04/Node 24 checks job uses the pinned pnpm, frozen install, check/test/build/lint, complete browser JSDoc checking, package consumer smoke and docs build/check. There is no dependency cache. Local success is not proof of remote CI success.

| Contract | Existing focused / integration checks |
| --- | --- |
| Collection reads/mutations, Unicode, stable IDs and tombstones | `runtime.test.ts`, `list.test.ts`, `text.test.ts`; browser core smoke |
| Transaction batching, nested/no-savepoint behavior, rollback, local callback failures and reentrant delivery | `runtime.test.ts`, collection tests; `resume.test.ts`, `async-resume.test.ts`, HTTP sync |
| Atomic policy, explicit rejection and original-result retry | Runtime policy tests, `server-reject.test.ts`, `retry.test.ts`; HTTP rejection recovery |
| Owned wire JSON and restore metadata | `wire.test.ts`, `client-checkpoint.test.ts`, `history.test.ts` |
| Pending prefix/conflicts, restore and catch-up | `replay-conflict.test.ts`, `client-checkpoint.test.ts`, `interleaving.test.ts`; HTTP/browser recovery |
| Save-before-send/success and lineage boundaries (application examples) | `persistent-resume.test.ts`, `persistent-http-sync.test.ts`, browser recovery tests, `document-lineage.test.ts` |
| Installed entrypoint and schema-specific declarations | `test/package-consumer/smoke.test.ts`; browser ESM smoke |

These are coverage pointers, not proof of every observable edge case. Dedicated core regression cases in `runtime.test.ts` cover nested transaction batching, escaping-error rollback, caught inner errors without savepoints, and the pending/sequence/notification behavior when local callbacks throw. Existing persistence/recovery tests separately cover callback failures at application boundaries. Do not infer complete coverage from the number of passing tests.

The deterministic interleaving suite uses three clients, five seeds, 200 scheduling steps and repeat-trace comparison, checking protocol invariants, a Value oracle, restore equivalence and convergence—not an independent List/Text model. Reproduce one seed with:

```sh
node --unhandled-rejections=strict --test test/interleaving.test.ts
node --test --test-name-pattern="seed=42" test/interleaving.test.ts
```

Browser JSDoc and Node integration tests do not replace interactive verification. Existing smoke/recovery instructions and the full JSDoc command are in the [examples guide](examples.md).

## Documentation preview

The tutorial and canonical core reference live in `docs/`. Staging copies those pages and generates only the examples page from `examples/README.md`. No documentation page is generated from the root README.

```sh
pnpm build
pnpm docs:build
pnpm docs:check
pnpm docs:serve
```

Preview at `http://127.0.0.1:5566/articollab/` (or `pnpm docs:serve 0` for an automatic port). The prefix matches the intended Pages project site; hash routes support deep-link reload without server fallback. Preview snapshots the staged assets at startup; restart it after editing. `docs:check` verifies the staged allowlist, local navigation/anchors, pinned CDN assets, and typechecks/runs the exact Counter snippet against built public ESM/declarations. Docs/tooling are not included in the production tarball. CDN-based rendering needs network access.

PRs only validate. Documentation artifact upload and the `deploy-docs` job are gated by repository variable `PAGES_ENABLED=true`, a main push/manual event, and successful checks. Only deployment gets `pages: write`/`id-token: write` and the `github-pages` environment; only validated `.docs-site/` is uploaded. Configure Pages uses `enablement: false`. With the variable unset, no upload/deploy occurs. Nothing in this setup enables Pages, changes repository visibility, or publishes npm.

The source repository remains private; the npm beta is public. Before enabling deployment, check [GitHub Pages support for private repositories](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) and review the staged content. A private repository does not make its documentation site private. After deployment, check the workflow commit, site URL and browser behavior; CI checks alone do not verify the rendered site.

[Previous: Examples guide](examples.md) · [Next: FAQ and limitations](faq.md)
