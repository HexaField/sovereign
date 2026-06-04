# Sovereign resilience: watchdog + orphan reaping + migration hardening

## Incident (2026-06-04)

Sovereign production was down. State found:

- `launchctl list` had **no** `com.sovereign.server` entry — the job was booted out of launchd. With the job unloaded, `KeepAlive=true` is inert: it only revives a _loaded_ job.
- An **orphan** server process (`node packages/server/dist/index.js`, reparented to PID 1) was still alive, started ~13h earlier, with a dead HTTP listener but still running cron-monitor and writing to the data dir. It ignored `SIGTERM` and only died on `SIGKILL`.

### Root cause

1. `bin/sovereign stop` → `_bootout_service` runs `launchctl bootout`. launchd deregisters the job and sends `SIGTERM`, but the script never confirms the process exited. The server's graceful-shutdown path wedged and ignored `SIGTERM`, so bootout removed the job while the process lived on as a PID-1 orphan.
2. Once the job was unloaded, nothing could bring it back — `KeepAlive` was powerless and there was no external monitor.
3. The likely trigger was the OpenClaw migration: its pre-flight runs `sovereign stop` (which orphaned the wedged process) and its final step runs `sovereign install` — which **only rewrites the plist file**; it never re-bootstraps or verifies the service. Stop-that-orphans + install-that-does- not-restart = exactly the observed state.

## Fixes

### 1. Independent watchdog (`com.sovereign.watchdog`)

A second launchd job, separate from the server, on a 60s `StartInterval`. Each tick (`bin/sovereign-watchdog.sh`):

1. If the operator intentionally stopped the service (pause sentinel `data/watchdog.paused` present), do nothing.
2. If `/health` responds, do nothing.
3. Otherwise run `sovereign start`, which reaps orphans, installs the plist, and bootstraps (or kickstarts) the service, then verifies health.

It is independent of the server job, so it recovers the server even when the server's own launchd job has been unloaded — the exact gap that caused this outage.

**Pause sentinel.** `stop` writes `data/watchdog.paused`; `start`/`restart` remove it. This stops the watchdog from fighting an intentional `stop` (e.g. maintenance) while still recovering _unexpected_ death (crash, or a job unloaded by something other than our `stop`).

### 2. Orphan reaping (`_reap_orphans`)

A helper that finds stray processes running the built server entry and terminates them (`SIGTERM`, grace period, then `SIGKILL`), preserving the launchd-managed PID when one is passed. Wired into:

- `_bootout_service` (stop) — guarantees nothing survives a bootout.
- `start`/`restart` before `bootstrap` (job not loaded) — never bootstrap alongside a leftover.
- `start`/`restart` before `kickstart` (job loaded but unhealthy) — clears any wedged duplicate while preserving the managed PID.

### 3. Migration hardening (`bin/sovereign-migrate.sh`)

- Pre-flight: after `sovereign stop`, assert no server process still lingers (reaping is now built into stop); abort with guidance if one does, so the migration never rewrites data underneath a live writer.
- Final `install` now lays down both the server and watchdog plists.
- Summary/next-steps and rollback notes mention the watchdog.

## Files

- `bin/sovereign-watchdog.sh` — watchdog tick script (new).
- `support/com.sovereign.watchdog.plist` — watchdog launchd template (new).
- `bin/sovereign` — `_reap_orphans`, watchdog install/ensure/bootout helpers, pause-sentinel handling, `watchdog` subcommand, wiring into start/stop/ restart/install.
- `bin/sovereign-migrate.sh` — pre-flight orphan assertion, watchdog mention.

## Not done (deliberately out of scope here)

- Crash-hard-on-fatal-server-error in the Node server (would let `KeepAlive` do its job when the job _is_ loaded). Worth doing, but a server-code change.
- Log rotation + the `WebSocket error` reconnect firehose (separate hygiene).
- Alerting/notifications on heal events.

## Verification plan (after review, before merge)

1. `bin/sovereign build` (type-check + build) on the branch.
2. `bin/sovereign install` — confirm both plists written.
3. `bin/sovereign watchdog status` — confirm loaded.
4. Simulate the incident: bootstrap server, then `kill -STOP` the server PID (or bootout without reap) to create an orphan/unloaded state; confirm the watchdog recovers within ~60s and reaps the orphan.
5. Confirm `sovereign stop` stays stopped (pause sentinel respected by watchdog).
6. Confirm `sovereign start` clears the sentinel and the watchdog resumes.
