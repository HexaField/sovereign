# CI baseline fix spec

## Goal

Restore the Sovereign CI baseline so active PRs are not blocked by repository-wide startup/check failures unrelated to feature work.

## Reproduced failures

1. `pnpm run check` fails in `packages/client` due to strict TypeScript errors, including `WorkspaceView.tsx` stale tab comparisons and unsafe open-file tab narrowing.
2. `pnpm run build` requires generated local certificates before the client build can complete.
3. `pnpm run test` fails at the workspace level when packages with zero tests exit non-zero.
4. CI test startup can crash before the app is ready when `node-pty` native bindings are unavailable during server bootstrap.

## Requirements

- Fix the strict TypeScript/check failures without changing product behavior beyond removing stale references.
- Keep the scope to CI-baseline fixes only.
- Do not reintroduce removed sidebar/workspace behavior just to satisfy types.
- Make server startup tolerant of optional terminal-native dependencies until a terminal session is actually created.
- Allow root test execution to proceed when a workspace intentionally has no tests.
- Verify with the actual repo commands used by CI where possible.

## Acceptance criteria

- `pnpm run check` passes.
- `pnpm run certs && pnpm run build` passes.
- `pnpm run test` no longer fails immediately because a workspace has no tests or because `node-pty` crashes server startup during bootstrap.
- A dedicated PR is opened containing only these CI-baseline fixes.
