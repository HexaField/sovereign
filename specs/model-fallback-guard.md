# Spec: Guard against GPT fallback model drift

## Objective

Prevent Sovereign threads from silently drifting to OpenClaw’s GPT fallback model (`gpt-5.2-codex`) when that model is not configured. The displayed model and the actual session model should remain aligned with the configured default (e.g. `github-copilot/claude-opus-4.6`) unless the user explicitly selects a configured model.

## Problem Statement

OpenClaw writes fallback model values into `~/.openclaw/agents/main/sessions/sessions.json` when the primary model errors. Sovereign reads this file directly to display and manage thread models. As a result, threads appear to “switch back” to `gpt-5.2-codex` even though it is not a configured or desired model.

## Requirements

- When `sessions.json` reports a model that is **not** in the configured model list, Sovereign must treat it as drift and restore the configured default model.
- The default model is the single source of truth when no user-selected model exists.
- User-selected models should continue to work **as long as they are configured**.
- Behaviour must be deterministic and safe if config or sessions files are missing.

## Acceptance Criteria

1. **Given** a session whose model is not in `openclaw.json`’s `agents.defaults.models`, **when** `/api/threads/:key/session-info` is called, **then** the response returns the configured default model and rewrites the session model to that default.
2. **Given** a session whose model is configured, **when** `/api/threads/:key/session-info` is called, **then** the response returns that configured model without modification.
3. **Given** a missing or unreadable config file, **when** `/api/threads/:key/session-info` is called, **then** the endpoint returns the raw session model without rewriting (no crash).
4. **Given** missing or unreadable sessions data, **when** `/api/threads/:key/session-info` is called, **then** the endpoint returns null model fields without crashing.

## Scope

- Server-only changes in `packages/server/src/threads/routes.ts` and tests.
- No client UI changes in this pass.

## Out of Scope

- Removing `sessions.json` dependency entirely (Phase 9 item).
- Changing OpenClaw’s fallback behaviour.
- Introducing new storage for model preferences outside `sessions.json`.

## Implementation Notes

- Use configured model list + default from `openclaw.json` as the authoritative set.
- Normalize session model as `provider/model` when possible for comparison.
- If the session model is not in the configured list and a default model exists, rewrite the session to the default using an atomic write.
- Keep behaviour silent; no new endpoints or UI changes required.
