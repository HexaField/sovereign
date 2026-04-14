# Spec: Radicle as Canonical Workspace Org with Secondary GitHub Remotes

## Objective

Decouple a Sovereign workspace membrane from any single GitHub organisation. A workspace/org in Sovereign represents the canonical membrane boundary and MAY be canonicalised around Radicle even when one or more contained repositories expose GitHub remotes. Provider-backed operations that need a default remote MUST prefer the workspace/project canonical remote instead of assuming the first discovered remote or a 1:1 mapping between workspace orgs and GitHub orgs.

## Problem Statement

Today Sovereign already parses multiple git remotes per project, but default-provider behaviour still effectively assumes that a workspace membrane maps to a single GitHub org and that “first remote wins”. In practice this breaks the intended model where:

- the membrane/workspace boundary is canonical and may be Radicle-first;
- a project can have both a canonical Radicle remote and one or more secondary GitHub remotes;
- publishing flows that omit a remote should target the canonical workspace/project remote, not whichever remote appears first in `.git/config`.

This creates wrong defaults for draft publishing and provider-backed issue creation when Radicle is canonical but GitHub is present as a secondary remote.

## Scope

In scope:

- Clarify and preserve `Org.provider` as the canonical workspace/membrane provider, not a statement that all repos in that org belong to a GitHub org.
- Clarify and preserve `Project.remote` as the preferred default remote name for provider-backed write flows.
- Auto-select a newly added project's preferred remote from discovered git remotes using canonical ordering rules.
- Order discovered remotes so canonical/preferred remotes are surfaced first.
- Use canonical/preferred remote selection when a write flow needs a default remote (issue creation, draft publish, offline queue metadata).
- Add regression tests for Radicle-canonical + GitHub-secondary repositories.

Out of scope:

- New database/storage backends.
- Renaming existing API fields.
- UI redesign for remote selection.
- Changing how explicit remote choices work.
- Cross-provider issue reference semantics beyond choosing the correct default remote.

## Behaviour Spec

### 1. Workspace membrane canonical provider

Given an `Org` with `provider: 'radicle'`, when projects inside that org contain both Radicle and GitHub remotes, then the org MUST still be treated as a single workspace membrane and MUST NOT be interpreted as needing a 1:1 GitHub org mapping.

Implications:

- `Org.provider` describes the canonical workspace provider preference.
- Secondary remotes on projects do not change workspace identity.

### 2. Project preferred remote derivation on add/detect

Given a project is added to an org and git remotes can be discovered from `.git/config`:

- if `Project.remote` is not explicitly supplied during creation, Sovereign MUST derive it automatically;
- if a discovered remote provider matches `Org.provider`, that remote MUST become the project's preferred remote;
- otherwise, if any remotes exist, the first discovered remote MAY be used as fallback;
- if no provider remotes are discovered, the project MAY remain without a preferred remote.

Edge cases:

- If multiple remotes match the canonical provider, the first matching discovered remote wins.
- If `.git/config` is missing or unreadable, project creation still succeeds and leaves `Project.remote` unset.

### 3. Canonical ordering of discovered remotes

Given remotes are requested for a project:

- if the project has `remote` set and that remote exists, it MUST be ordered first;
- else if the org has a canonical `provider` and one or more remotes match that provider, the first matching remote MUST be ordered first;
- all other remotes MUST remain present and retain their relative order after the preferred remote.

This ordering MUST apply without dropping any remotes.

### 4. Default remote selection for provider-backed writes

Given a write flow requires a remote but the caller does not effectively pin one, Sovereign MUST use the canonical ordering above rather than blindly using the first parsed remote from git config.

This applies to:

- issue creation defaulting behaviour;
- draft publishing to a provider issue;
- queued offline metadata that records which remote a pending create/comment applies to.

Given the caller explicitly supplies a valid remote name, that explicit choice MUST win.

Error handling:

- If no remotes exist, write flows MUST fail with the existing error behaviour.
- If an explicitly requested remote does not exist, existing error behaviour MAY remain unchanged.

### 5. Backwards compatibility

Given existing workspaces and projects:

- existing `Org.provider` values remain valid;
- existing `Project.remote` values remain valid and take precedence for default ordering;
- API response shapes for orgs, projects, issues, and drafts MUST remain backwards compatible.

## Data Model

No new top-level entities are required.

Existing fields are re-affirmed:

- `Org.provider?: 'radicle' | 'github'` — canonical workspace/membrane provider preference.
- `Project.remote?: string` — preferred default remote name for provider-backed write flows.

No migration is required. Newly added projects may now persist `Project.remote` automatically when a canonical remote can be inferred.

## API / UI Implications

### API

No endpoint shape changes are required.

Observable behaviour changes:

- `POST /api/orgs/:orgId/projects` may return a project whose `remote` is automatically populated from discovered git remotes.
- provider-backed write routes that previously defaulted to “first remote” will now default to the project's preferred/canonical remote.

### UI

No UI contract changes are required.

Existing clients that read `project.remote` benefit from more accurate defaults. Workspace membranes continue to use org identity, not GitHub org ownership, as the membrane boundary.

## Component Boundaries

Modules affected:

- `packages/server/src/orgs/` — derive and persist project preferred remote.
- `packages/server/src/index.ts` or extracted remote-discovery helper — canonical ordering of discovered remotes.
- `packages/server/src/issues/` — default remote selection and queued remote metadata.
- `packages/server/src/drafts/` — default publish remote selection.

## Implementation Design

1. Extract git-remote parsing and canonical ordering into a reusable server helper module.
2. Reuse that helper in org/project creation to derive `Project.remote` from discovered remotes and org provider.
3. Reuse ordered remotes in the server's runtime `getRemotes()` path so downstream modules naturally see canonical ordering.
4. Update draft publishing and issue-creation fallback logic to select from ordered remotes while preserving explicit remote choices.
5. Add focused unit tests around remote discovery/ordering plus org-manager and draft/issue regressions.

## Acceptance Criteria

1. Given a Radicle org and a repo with `origin=github` and `rad=radicle`, when the project is added, then `project.remote` is set to `rad`.
2. Given a project with preferred remote `rad`, when remotes are requested, then `rad` is returned before `origin`.
3. Given draft publish in a Radicle-canonical workspace with both remotes, when no remote is explicitly chosen, then the created issue uses the Radicle remote.
4. Given issue creation without an effective explicit remote in a Radicle-canonical workspace, when both Radicle and GitHub remotes exist, then the Radicle remote is used by default.
5. Given a project already has `remote` set, when remotes are requested, then that remote remains the default regardless of provider ordering.
