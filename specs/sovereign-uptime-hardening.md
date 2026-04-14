# Spec: Harden Sovereign launchd uptime and guarded reloads

## Objective

Make Sovereign behave like a durable local service on macOS: launchd owns process lifetime, crashes auto-recover, rebuild/reload operations are guarded so a failed check or build never takes the running app down, and successful reloads are verified with an HTTP health check before being treated as complete.

## Problem Statement

Sovereign currently has two conflicting service paths. `bin/sovereign` installs a launchd plist that runs `packages/server/dist/index.js`, while `bin/sovereign-launchd.sh` runs `tsx watch src/index.ts` with hard-coded environment. `bin/rebuild-server.sh` builds in place and unloads/reloads the service, creating avoidable downtime. The existing plist template also writes stdout and stderr to the same placeholder file and relies on legacy `load`/`unload` behaviour.

The result is fragile uptime:

- build/restart flows can take the app down before the replacement is known-good
- launchd management is inconsistent with the actual wrapper script
- post-restart success is not robustly verified
- logs and service ergonomics are rough

## Requirements

- Sovereign MUST run under a single, explicit launchd-managed service definition on macOS.
- The launchd service MUST use `KeepAlive` so crashes are restarted automatically.
- A guarded rebuild/reload command MUST complete checks/builds before touching the running service.
- If a rebuild or validation step fails before reload, the current service MUST remain up.
- Reload MUST verify HTTP health after restart and report failure clearly.
- If reload fails health verification, the command MUST attempt rollback to the last known-good build and restore service.
- Logs MUST be clear and easy to inspect from CLI commands.
- Developer-facing commands MUST make start/stop/status/build/reload/logs/health obvious.

## Acceptance Criteria

1. **Given** Sovereign is installed as a launchd service on macOS, **when** the server process exits unexpectedly, **then** launchd restarts it automatically via `KeepAlive`.
2. **Given** Sovereign is currently serving traffic, **when** `bin/sovereign build` or equivalent guarded reload is run and any check/build step fails, **then** the running service remains up and no reload is attempted.
3. **Given** a successful build, **when** the guarded reload restarts the service, **then** the command waits for `/health` to return success before reporting completion.
4. **Given** a successful build but a bad runtime startup after reload, **when** health verification times out or fails, **then** the command restores the previous server/client build artifacts, restarts the prior version, and exits non-zero.
5. **Given** a developer runs the service commands, **when** they ask for status, health, or logs, **then** the CLI shows the launchd label/state, key file paths, and easy access to stdout/stderr logs.
6. **Given** a fresh install on macOS, **when** the developer runs the install/start flow, **then** launchd uses the repo wrapper script with repo-derived environment instead of hard-coded machine-specific secrets.

## Scope

- `bin/sovereign` CLI lifecycle/build commands
- launchd wrapper/support files in `bin/` and `support/`
- README/runbook updates for service usage
- Focused tests for generated launchd config / command behaviour where practical
- Manual verification on this machine using `launchctl` and HTTP `/health`

## Out of Scope

- Linux systemd support beyond preserving the existing non-macOS fallback
- Broader deployment/orchestration changes outside the local launchd workflow
- Deep application health semantics beyond the existing `/health` endpoint

## Behaviour Spec

### Single launchd service path

- macOS service management uses one plist template and one wrapper script.
- The plist points at the wrapper script, not directly at a possibly version-specific Node path in app code.
- The wrapper script resolves repo-local environment, changes into the repo, and executes the built server entrypoint.

### Guarded build before reload

- `sovereign build` performs checks/builds in dependency order: core, client, server.
- The command snapshots the currently deployed `dist` outputs before mutating them.
- The running service is not stopped or kicked until all build steps succeed.

### Verified reload with rollback

- After a successful build, if the service is running, the command restarts it through launchd.
- The command polls `http://127.0.0.1:<port>/health` for a bounded interval.
- On success, backup artifacts are discarded and the command exits zero.
- On failure, the command restores the previous build outputs from backup, restarts the service again, verifies the old version is healthy, and reports rollback status.

### Developer ergonomics and logs

- `sovereign start|stop|restart|status|build|reload|health|logs` are first-class commands.
- `status` shows launchd state, plist path, log directory, and health URL.
- `logs` can tail stdout or stderr distinctly, with a combined mode if desired.
- Install/start flows create the required data/log directories automatically.

## Component Boundaries

- `bin/sovereign` owns lifecycle orchestration and guarded reload logic.
- `bin/sovereign-launchd.sh` owns the actual runtime execution contract under launchd.
- `support/com.sovereign.server.plist` defines launchd behaviour only; it stays template-driven.
- `packages/server/src/routes/health.ts` remains the health probe endpoint used for verification.

## Implementation Design

### File-level plan

- **`specs/sovereign-uptime-hardening.md`**: spec and design contract for this work.
- **`bin/sovereign`**: rewrite macOS service management around bootstrap/bootout/kickstart, health checks, guarded build, rollback, and log helpers.
- **`bin/sovereign-launchd.sh`**: simplify to repo-derived env + built server startup; remove hard-coded secrets and tsx watch usage.
- **`support/com.sovereign.server.plist`**: point at wrapper script, add placeholders for stdout/stderr paths, enable `RunAtLoad`, retain `KeepAlive`/throttle.
- **`README.md`**: document service commands and guarded reload semantics.

### Key decisions

- Use built `dist/index.js` in production launchd mode rather than `tsx watch`; watch mode is great for dev, not for stable background uptime.
- Use launchd `bootstrap`/`bootout`/`kickstart -k` instead of legacy `load`/`unload`.
- Back up `packages/{core,client,server}/dist` before rebuild so startup regressions can roll back to a known-good artifact set.
- Keep the health contract simple by reusing `/health` rather than inventing a new probe.

### Risks and mitigations

- **Node path drift**: wrapper resolves `node` at runtime and plist runs the wrapper, reducing hard-coded path brittleness.
- **Rollback gaps**: back up all built package `dist` outputs touched by the build sequence, not just server.
- **Service false-positive**: require actual HTTP health success after restart, not merely `launchctl list`.
- **Log confusion**: split stdout/stderr files and expose both in CLI output.
