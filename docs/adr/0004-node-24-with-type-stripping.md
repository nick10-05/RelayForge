# ADR 0004: Node.js 24 LTS running TypeScript by type stripping

- **Status:** Accepted (14 Nov 2026; Node 26 → 24 in design v2.3)
- **Related:** design §9, §12 (D1)

## Context

The server is written in TypeScript. The usual ways to run it are a build step (`tsc` or a bundler
to `dist/`) or a loader (`tsx`, `ts-node`). Both add tooling, source maps and a gap between the code
you read and the code that runs.

Node 22.18+/24 can run `.ts` files directly by **stripping** type annotations (replacing them with
whitespace, so line and column numbers stay exact). It does no type checking and no transformation:
syntax that needs code generation (`enum`, `namespace` with values, constructor parameter
properties) is rejected.

On the runtime version: Node 24 is the current LTS line (supported to April 2028, beyond this
project's lifetime). Node 26 was considered and set aside: 24 is the more conservative choice and
moving later is a one-line change.

## Decision

- **Runtime:** Node.js 24 LTS, pinned in `.nvmrc`, `engines` (with `engine-strict`), the Docker base
  image (`node:24-alpine`) and CI.
- **Execution:** `node apps/server/src/server.ts` — no build step and no loader, in development
  (`node --watch`), for migrations and in production. (Vitest transforms test files with its own
  pipeline; it accepts the same code.)
- **Rules that make it work** (enforced by `tsconfig.json`):
  - `erasableSyntaxOnly` — no `enum`, value `namespace`, or parameter properties;
  - `verbatimModuleSyntax` — type-only imports must say `import type`;
  - `allowImportingTsExtensions` — relative imports include `.ts`;
  - no `paths` aliases (Node wouldn't resolve them).
- **Type checking** is separate: `tsc --noEmit` in `npm run check` and CI.

## Consequences

**Good**
- What runs is the source file. Stack traces point at real lines without source maps.
- Fewer dependencies and one less build artifact; the Docker image copies `src/` and runs it.
- The erasable-only rule is checked twice: by `tsc` and by Node itself at load time.

**Bad / accepted**
- Types are not checked at run time, so `tsc` in CI is mandatory — a type error doesn't stop the
  server starting.
- Some TypeScript features are off the table (`enum` → `as const` objects / string unions).
- Dependencies in `node_modules` must be JavaScript (Node won't strip types there) — true of every
  package we use.
- The dashboard still has a build (Vite), because browsers need bundled JavaScript.
- Node 24.15.0 crashed under heavy connection churn on Windows during load testing (fixed in later
  24.x patches); local development uses 24.22, and raising `engines` to `>=24.16` is on the to-do list.

## Alternatives considered

| Option | Why not |
|---|---|
| `tsc` build to `dist/` | Build step, source maps, two trees to keep in sync |
| `tsx` / `ts-node` | Extra dependency doing what Node now does natively |
| esbuild/tsup bundle | Fast, but a build artifact the project doesn't need |
| Node 26 | Newer, but 24 is LTS for longer than this project needs; switching later needs no code changes |
| Plain JavaScript + JSDoc | Weaker types for the parts (engine, crypto) where types catch real bugs |

## Interview version

"Node 24 runs TypeScript files directly by stripping the types, so there's no build step for the
server. The price is a few TypeScript features I can't use, like enums, and that type checking is a
separate `tsc --noEmit` step in CI — Node won't stop you running code that doesn't type-check."
