# Repository Guidelines

This package serves two orchestrators: a pi parent that uses the extension's tools, and an external orchestrator (e.g. Claude Code) that runs pi children in Luvus panes through the packaged `pi-luvus` skill (`skills/pi-luvus/`, spec'd in `external-orchestration`). Changes to `pi-extension/luvus/luvus-done.ts`, the `PI_LUVUS_*` env vars, or the `.exit` sidecar format must keep `external-orchestration` passing.

## Project Structure & Module Organization

This package is a Pi extension that integrates pi with Luvus: asynchronous subagents in panes, live agent status, and Luvus bar and notification modules. Runtime TypeScript lives in `pi-extension/luvus/`: `index.ts` registers tools and commands, `luvus.ts` handles panes and tabs, and the other modules manage sessions, status, activity, and completion. Agent definitions live in `agents/*.md`; the Claude stop hook (a node script) is under `pi-extension/luvus/plugin/hooks/`. Unit tests are in `test/*.test.ts` and `test/test.ts`; Behavior specifications and active proposals live in `openspec/`.

## Luvus Behavior Is Not Documented Here

Luvus is third-party software and changes between releases. No local document is an authority for Luvus behavior. This includes this repo's docs, specs, OpenSpec changes and archives, and skill references. Do not write Luvus feature behavior into code comments, docs, or specs. If code depends on Luvus behavior, describe only what this code does.

To check a Luvus flag, run `luvus help <topic>` on the installed binary. Do not rely on any other source for Luvus behavior.

## Build, Test, and Development Commands

- `pnpm install` installs the package dependencies. Its `prepare` script points `core.hooksPath` at `.githooks`, so the pre-commit gate installs itself.
- `pnpm test` runs the whole unit suite with Node's built-in test runner. It globs `test/*.ts`, which covers `test/test.ts` and every `test/*.test.ts`.
- `pnpm run typecheck` runs `tsc --noEmit`. The package loads `.ts` files directly and has no build script.
- `pnpm run lint` and `pnpm run format:check` check ESLint and Prettier. `pnpm run format` rewrites the tree with Prettier.
- `pi install /path/to/pi-luvus` installs the local extension for manual testing in Pi.

## Coding Style & Naming Conventions

Follow the surrounding TypeScript style: two-space indentation, double-quoted strings, semicolons, and `.ts` extensions in relative imports. Use `camelCase` for functions and variables, `PascalCase` for types, and descriptive kebab-case module filenames such as `luvus-done.ts`. Keep Luvus process and surface operations in `luvus.ts`. Prettier and ESLint enforce this: run `pnpm run format` to rewrite and `pnpm run lint` to check. `.prettierignore` excludes markdown and TOML, so review prose changes by hand.

## Testing Guidelines

Use `node:test` and `node:assert/strict`. Name focused tests `*.test.ts`; add unit cases for pure behavior. Tests run in CI and as gates, where no Luvus instance exists. Tests that agents write must NOT depend on a real Luvus: stub `luvus` calls (for example `__setLuvusExecForTests__`) and use fake `LUVUS_*` values. Agents and subagents must not run live Luvus tests or add them to the suite. Do not add tests that open many panes at once.

The user does all live tests and acceptance. A proposal can include a live test or an acceptance step only when the user approves it. When you plan a change, do not ask for live measurements (timings, connection counts, runs with many panes). That is overreach. Verify a plan with unit tests that use fakes, the type check, and `luvus help` output. No coverage threshold is configured. Before submitting, run `pnpm test`, `pnpm run lint`, `pnpm run format:check` and `pnpm run typecheck`. The pre-commit hook runs the same four, and CI (`.github/workflows/ci.yml`) runs them on Node 22 for each push to `main` and each pull request.

## Never Leave a Dirty Worktree


