# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@prompt-helm/sdk`, the Node.js SDK of [PromptHelm](https://prompthelm.app). An app fetches the
live version of a prompt at runtime (`ph.get("support-reply", { vars, fallback })`), so changing a
prompt in the dashboard needs no rebuild and no redeploy. The package also ships
`npx @prompt-helm/sdk pull`, which writes every published prompt to a fallbacks file.

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
  PromptHelm; that is a selling point. The SDK's one report is an error code in
  `x-prompthelm-fallback` (`FALLBACK_HEADER`), sent with its next request after a fallback or a
  stale prompt was served; `reportFallbacks: false` turns it off.
- **The service imports this package.** PromptHelm's server types its responses with
  `PromptPayload` and `PromptListPayload`, extracts variables with `extractVariables`, reads
  `FALLBACK_HEADER` and stores only a value in `ERROR_CODES`. Together they are the wire
  contract: change it here first and release, then the service upgrades. Never break any of them
  in a minor or a patch.
- **`pull` never reaches the library.** It lives in `src/pull.ts` and builds to `dist/cli.js`
  (the package's `bin`, Node only); `src/index.ts` must not import it, so an app's bundle stays
  under 2 kB. That figure, stated in the README and on prompthelm.app, is minified and gzipped, as
  bundlephobia and an app's bundler count it (1.2.0: 1.4 kB ESM, 1.6 kB CJS); the unminified
  `dist` keeps JSDoc on class members, so keep long notes there as `//` comments. tsup builds the
  two in parallel, so the library's `clean` spares `cli.js`.
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
