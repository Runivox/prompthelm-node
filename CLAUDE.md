# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@prompt-helm/sdk`, the Node.js SDK of [PromptHelm](https://prompthelm.app). An app fetches the
live version of a prompt at runtime (`ph.get("support-reply", { vars, fallback })`), so changing a
prompt in the dashboard needs no rebuild and no redeploy. During an A/B test (Pro), the SDK picks
the live version or the variant for each call (`unit` keeps a user on one); `ph.resolve()` says
which version it served and takes the call's outcome and model usage, which the SDK sends to
PromptHelm as totals. The package also ships `npx @prompt-helm/sdk pull`, which
writes every published prompt to a fallbacks file.

This repository is the SDK's only home since 2026-11-09, when it moved out of the service's
(private) repository. It is public and MIT licensed; the service itself is not here.

## Commands

```bash
npm install
npm test                  # vitest
npm run typecheck
npm run lint              # Biome;  npm run format  to fix formatting
npm run build             # tsup: dist/index.js (ESM), dist/index.cjs, dist/cli.js
npm run dev               # tsup --watch
npm run smoke             # after a build: loads dist/ and runs it, as CI does on Node 18 and 20

npx vitest run test/client.test.ts -t "fallback"
```

## Invariants

- **The SDK must not take the customer's app down.** With a `fallback`, every failure (network,
  timeout, 401, 404, a live version needing a variable the code doesn't pass) returns the fallback
  and reports through `onError`. After the first fetch it serves from cache and refreshes in the
  background; a failed refresh keeps the cached text and retries after a ttl.
- **Variables are filled in here, on the customer's server.** Their values never reach
  PromptHelm, and neither does an A/B test's `unit`; that is a selling point. The SDK reports two
  things: an error code in `x-prompthelm-fallback` (`FALLBACK_HEADER`), with the next request for
  the slug after a fallback or a stale prompt was served (`reportFallbacks: false` turns it off),
  and, under an A/B test, totals in `POST /v1/reports` (`ReportPayload`; `reportResults`, which
  follows `reportFallbacks` unless set): calls served per version, skipped calls, and the
  outcomes and model usage the app reports. They are sent within a ttl of the first count (a timer
  that doesn't keep the process alive) or by `flush()`, kept for the next try when PromptHelm
  can't be reached or answers 5xx, and dropped when it refuses them. A variant the call can't fill
  in serves the live version and counts as `skipped`, never as a fallback. Forced calls (`force`)
  are never counted.
- **The service imports this package.** PromptHelm's server types its responses with
  `PromptPayload` (with its optional `experiment`, a `PromptExperiment`) and
  `PromptListPayload`, reads `ReportPayload` (and `latencyBucket` for its buckets), extracts
  variables with `extractVariables`, reads `FALLBACK_HEADER`, and stores only a value in
  `ERROR_CODES`. Together they are the wire contract: change it here first and release, then the
  service upgrades. Never break any of them in a minor or a patch.
- **A/B assignment is part of the contract.** A unit's bucket is
  `fnv1a32(utf8("<experiment id>:<unit>")) % 100` and buckets below `weight` get the variant
  (`src/experiment.ts`), so growing the share only moves units to the variant. An SDK in another
  language must pick the same buckets: the vectors in `test/client.test.ts` were computed
  independently. Counts are kept per test and per share (`weight`), so a changed share never
  mixes them; a ticket is `<experiment id>.<version>.<weight>`, nothing about the user.
- **`pull` never reaches the library.** It lives in `src/pull.ts` and builds to `dist/cli.js`
  (the package's `bin`, Node only); `src/index.ts` must not import it, so an app's bundle stays
  under 3 kB. That figure, stated in the README and on prompthelm.app, is minified and gzipped, as
  bundlephobia and an app's bundler count it (1.2.0: 1.4 kB ESM, 1.6 kB CJS; 1.3.0, with A/B
  tests, outcomes and usage: 2,742 B ESM, 2,958 B CJS, so little room is left). Measure both after
  a change:
  `npx esbuild src/index.ts --bundle --minify --format=esm --platform=neutral | gzip -9 | wc -c`
  (and `--format=cjs`). The unminified `dist` keeps JSDoc on class members, so keep long notes
  there as `//` comments. tsup builds the two in parallel, so the library's `clean` spares
  `cli.js`.
- **Defaults are stated elsewhere.** The 60 s ttl, the 3 s timeout and "Node.js 18 and later"
  appear in the README and on prompthelm.app; changing one means changing those too.
- **Node 18 is the floor.** vitest and tsup need Node 22.12 or later, so CI builds with a current
  Node and runs `scripts/smoke.mjs` against `dist/` on Node 18 and 20. Don't use an API in `src`
  that Node 18 lacks.
- **No runtime dependencies.**

## Conventions

- **TypeScript 6.0** (`~6.0.3`), strict, no `any`.
- **Biome** for lint and format, line width 100.
- The library logs nothing itself; the default `onError` (`console.warn`) is the only exception.
  The `pull` CLI prints to the console.
- **Conventional commits**, English, imperative, lowercase: `feat: …`, `fix(pull): …`.

## Releasing

1. Bump `version` in `package.json` (semver; see the contract above) and commit it:
   `chore: release 1.2.3`.
2. `git tag v1.2.3 && git push origin main v1.2.3`.

`.github/workflows/release.yml` publishes through npm's trusted publishing (OIDC): no token, and
npm attaches provenance. It refuses a tag that doesn't match `package.json`. The trusted publisher
on npmjs.com names this repository and `release.yml`; renaming either breaks publishing.
`repository.url` in `package.json` must keep matching this repository for the same reason.

Versions 0.1.0 and 0.2.0 belong to an earlier PromptHelm and are deprecated.
