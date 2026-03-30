# Phase 9: Workspace Consolidation & Org Standardisation — Specification

**Status:** Draft
**Revision:** 1
**Date:** 2026-03-30

This phase standardises all repository locations, Sovereign org data, OpenClaw membrane context files, and memory references across all three machines. It prepares the data foundation that the Agent Core (Phase 10) depends on — clean org boundaries, valid paths, and consistent context.

---

## §1 — Problem Statement

### §1.1 — Current State

Repositories, workspace references, and org data are inconsistent across machines and configuration files:

- **Mac**: Repos scattered between `~/workspaces/<org>/<repo>` (canonical), `~/Desktop/` (95+ legacy repos), and `~/repos/` (empty, but referenced in memory files)
- **Josh Ubuntu 22**: Repos in `~/ci-workspace/`, `~/workspaces/`, `~/Desktop/`, `~/repos/`, and `~/` root — no consistent convention
- **Field Ubuntu 24**: Only `~/ci-workspace/` with CI-related repos

Sovereign org data (`orgs.json`) has stale paths:
- Companion org points to `~/Desktop/companionintelligence` — repos are now at `~/workspaces/companionintelligence/`
- Companion project names are stale (`CI-OS-Hub-repo` should be `CI-Hub`)
- Missing orgs for repos that already exist at `~/workspaces/` (hexafield, atlasresearch, connectionengine)
- Missing projects within existing orgs (ad4m-sfu, flux-sfu, agenda in Coasys)

OpenClaw context files (`membranes/*/context.md`, `MEMORY.md`, `TOOLS.md`) reference paths that no longer exist or have moved.

### §1.2 — Why This Matters for Phase 10 (Agent Core)

The Agent Core requires:
- **Memory indexing** (10.1) crawls per-org directories — stale paths = failed ingestion
- **Session store** (10.2) uses thread identity `{orgId}/{projectId}/{entityType}:{ref}` — broken org data breaks routing
- **System prompt assembly** (10.4) includes org context files — stale context = hallucinated paths
- **Worktree-agent binding** (10.9) creates worktrees within projects — invalid project paths = broken agent isolation

### §1.3 — Worktree Limitations

Git worktrees provide excellent code-level parallelism (multiple agents editing different branches of the same repo), but have real limitations:

- **Gitignored build artifacts** (`node_modules/`, `dist/`, `.env`): per-worktree, so each worktree gets its own copy. This works correctly — `pnpm install` and builds are isolated.
- **Out-of-repo runtime state**: Docker volumes, databases, `.internal/` directories, container names — these are NOT per-worktree. Two worktrees of CI-Hub both running Docker stacks will fight over container names and shared volumes.
- **Submodules**: Need separate checkout per worktree, adding complexity.

Worktrees are the right primitive for code parallelism. Runtime parallelism (running multiple instances of an app) needs separate mechanisms: namespaced Docker projects, per-worktree volume prefixes, or dedicated test environments. Phase 10's worktree-agent binding MUST account for this distinction.

---

## §2 — Org & Membrane Mapping

### §2.1 — Target Org Structure

The canonical repo root on all machines is `~/workspaces/<org>/<repo>`. Each Sovereign org maps to a directory under this root, and each OpenClaw membrane maps to a Sovereign org.

| Sovereign Org | Org Path | OpenClaw Membrane(s) | Provider | Notes |
|---|---|---|---|---|
| Global | `~/.openclaw/workspace` | `membranes/openclaw/`, `membranes/philosophy/` | — | The agent's home. Philosophy stays here (notes only, no repos). |
| Companion | `~/workspaces/companionintelligence` | `membranes/companion/` | github | CI-Hub, CI-Portal, CI-Server, CI-Marketplace |
| Coasys | `~/workspaces/coasys` | `membranes/adam/` | github | AD4M, Flux, WE, and related repos |
| Hexafield | `~/workspaces/hexafield` | — | github | Josh's personal projects: Sovereign, ad4m-web, stateproof |
| Atlas Research | `~/workspaces/atlasresearch` | `membranes/atlas/`, `membranes/dweb/`, `membranes/metamyth/`, `membranes/harmony/` | github | Research group workspace. Absorbs dweb, metamyth, harmony membranes. |
| Connection Engine | `~/workspaces/connectionengine` | — | github | Connection Engine project |

### §2.2 — Membrane Consolidation

The following OpenClaw membranes are consolidated into Atlas Research:
- `membranes/dweb/` → Atlas Research (holons, regen-map, ARG, folk, community-archive)
- `membranes/metamyth/` → Atlas Research (concept stage, no repos)
- `membranes/harmony/` → Atlas Research (sovereign Discord clone)

These membranes' `context.md` files MUST be updated to reference Atlas Research as the parent org, and any active repos MUST be moved to `~/workspaces/atlasresearch/`.

`membranes/philosophy/` stays in Global (notes only, no code repos).

### §2.3 — OpenClaw Backwards Compatibility

The OpenClaw workspace convention (`MEMORY.md`, `memory/*.md`, `membranes/*/context.md`, `SOUL.md`, `AGENTS.md`) MUST be maintained. Sovereign reads these files for context. Changes to membrane structure must not break OpenClaw's ability to load workspace files.

Specifically:
- `membranes/` directory structure is preserved — membrane directories are NOT renamed or deleted
- `context.md` files within each membrane are updated with correct paths and org references
- `MEMORY.md` is updated to remove stale references and add correct ones
- New membranes can be added as needed
- Membranes that are consolidated (dweb, metamyth, harmony → atlas) keep their directories but their `context.md` files are updated to note the consolidation and cross-reference the Atlas Research membrane

---

## §3 — Repository Moves

### §3.1 — Mac (Primary Machine)

**Active repos to move from `~/Desktop/` to `~/workspaces/`:**

| Repo | Current | Target | Org |
|---|---|---|---|
| harmony | `~/Desktop/harmony` | `~/workspaces/atlasresearch/harmony` | Atlas Research |
| harvest | `~/Desktop/harvest` | `~/workspaces/atlasresearch/harvest` | Atlas Research |
| holons-game | `~/Desktop/holons-game` | `~/workspaces/atlasresearch/holons-game` | Atlas Research |
| regen-map | `~/Desktop/regen-map` | `~/workspaces/atlasresearch/regen-map` | Atlas Research |
| arg-app | `~/Desktop/arg-app` | `~/workspaces/atlasresearch/arg-app` | Atlas Research |
| arg-website | `~/Desktop/arg-website` | `~/workspaces/atlasresearch/arg-website` | Atlas Research |
| openclaw | `~/Desktop/openclaw` | `~/workspaces/hexafield/openclaw` | Hexafield |

**Stale worktree clones to evaluate:**

| Clone | Location | Parent Repo | Action |
|---|---|---|---|
| ad4m-rest-refactor | `~/workspaces/coasys/ad4m-rest-refactor` | `coasys/ad4m` | Remove if branch merged, else convert to worktree |
| ad4m-sfu | `~/workspaces/coasys/ad4m-sfu` | `coasys/ad4m` | Remove if branch merged, else convert to worktree |
| flux-sfu | `~/workspaces/coasys/flux-sfu` | `coasys/flux` | Remove if branch merged, else convert to worktree |

**Desktop repos to leave in place** (dormant/archived, not worth moving):
- All non-active repos (90+) remain on `~/Desktop/`. These are not registered in Sovereign and don't need clean paths. If any become active later, they get moved at that time.

### §3.2 — Josh Ubuntu 22 (Secondary)

Standardise to `~/workspaces/<org>/<repo>`:

| Current | Target | Notes |
|---|---|---|
| `~/ci-workspace/CI-OS-Hub` | `~/workspaces/companionintelligence/CI-Hub` | Primary CI test copy |
| `~/ci-workspace/CI-App-Store` | Remove or `~/workspaces/companionintelligence/CI-Marketplace` | May not be needed |
| `~/workspaces/coasys/ad4m-sfu` | Keep | Already correct |
| `~/workspaces/companionintelligence/CI-Hub` | Keep | Already correct |

Desktop repos on Ubuntu are all dormant (old IR Engine, Holochain experiments, etc.) — leave in place.

### §3.3 — Field Ubuntu 24 (CI Target)

Standardise to `~/workspaces/<org>/<repo>`:

| Current | Target | Notes |
|---|---|---|
| `~/ci-workspace/CI-OS-Hub` | `~/workspaces/companionintelligence/CI-Hub` | Rename to match canonical name |
| `~/ci-workspace/CI-App-Store` | `~/workspaces/companionintelligence/CI-Marketplace` | Rename |
| `~/ci-workspace/CI-Marketplace` | `~/workspaces/companionintelligence/CI-Marketplace` | Already correct name, move path |

---

## §4 — Sovereign Org Data Updates

### §4.1 — orgs.json Corrections

The Sovereign org store (`{dataDir}/orgs/orgs.json`) MUST be updated:

**Fix existing orgs:**
- Companion: path `~/Desktop/companionintelligence` → `~/workspaces/companionintelligence`

**Add new orgs:**
- Hexafield: path `~/workspaces/hexafield`, provider `github`
- Atlas Research: path `~/workspaces/atlasresearch`, provider `github`
- Connection Engine: path `~/workspaces/connectionengine`, provider `github`

### §4.2 — Project Corrections

**Companion org projects:**
- `CI-OS-Hub-repo` → rename to `CI-Hub`, update repoPath to `~/workspaces/companionintelligence/CI-Hub`
- `CI-Cloud` → update repoPath to `~/workspaces/companionintelligence/CI-Cloud` (project name stays as CI-Cloud, maps to CI-Portal product name)
- `CI-Server` → update repoPath to `~/workspaces/companionintelligence/CI-Server`
- `CI-OS` and `CI-OS-Hub-Docs` → evaluate: remove if not actively used
- Add `CI-Marketplace` project

**Coasys org projects:**
- Add missing: `ad4m-sfu`, `flux-sfu`, `agenda`, `template-monorepo` (if they are standalone repos, not worktrees)

**Hexafield org projects:**
- Add: `sovereign`, `ad4m-web`, `stateproof`, `openclaw` (after move)

**Atlas Research projects:**
- Add after repo moves: `harmony`, `harvest`, `holons-game`, `regen-map`, `arg-app`, `arg-website`

---

## §5 — Context File Updates

### §5.1 — MEMORY.md

Remove or update:
- `~/repos/adam/ad4m-rest-refactor` and `~/repos/adam/flux-rest-migration` references — these no longer exist
- `~/Desktop/companionintelligence/CI-OS-Hub-repo` → `~/workspaces/companionintelligence/CI-Hub`
- `~/Desktop/companionintelligence/CI-Cloud` → `~/workspaces/companionintelligence/CI-Cloud`
- `/tmp/CI-Marketplace` → `~/workspaces/companionintelligence/CI-Marketplace`
- Update test machine paths in the table if they change

### §5.2 — membranes/adam/context.md

Update all project paths from `~/Desktop/` to `~/workspaces/coasys/`:
- `~/Desktop/ad4m` → `~/workspaces/coasys/ad4m`
- `~/Desktop/flux` → `~/workspaces/coasys/flux`
- `~/Desktop/we` → `~/workspaces/coasys/we`
- `~/Desktop/harvest` → `~/workspaces/atlasresearch/harvest` (harvest moves to Atlas Research)
- `~/Desktop/nextgraph-adam-language` → note as paused/archived (still on Desktop)
- `~/Desktop/ad4m-link-language-template` → note as paused/archived (still on Desktop)

### §5.3 — membranes/companion/context.md

Update all project paths:
- `~/Desktop/companionintelligence/CI-OS-Hub-repo` → `~/workspaces/companionintelligence/CI-Hub`
- `~/Desktop/companionintelligence/CI-Cloud` → `~/workspaces/companionintelligence/CI-Cloud`
- `~/Desktop/companionintelligence/CI-App-Store-repo` → `~/workspaces/companionintelligence/CI-Marketplace`
- `~/Desktop/CI-Server` → `~/workspaces/companionintelligence/CI-Server`
- Other CI Desktop refs: update or note as archived

### §5.4 — membranes/dweb/context.md

Add note that this membrane is consolidated into Atlas Research. Update paths for repos that move:
- `~/Desktop/holons-game` → `~/workspaces/atlasresearch/holons-game`
- `~/Desktop/regen-map` → `~/workspaces/atlasresearch/regen-map`
- Other repos: note as paused/archived with current Desktop locations

### §5.5 — membranes/harmony/context.md

Add note that this membrane is consolidated into Atlas Research. Update:
- `~/Desktop/harmony` → `~/workspaces/atlasresearch/harmony`

### §5.6 — membranes/openclaw/context.md

Update:
- `~/Desktop/openclaw` → `~/workspaces/hexafield/openclaw` (after move)

### §5.7 — New: membranes/atlas/context.md

Create or update with Atlas Research overview, listing all absorbed projects and their repos.

---

## §6 — Execution Order

1. **Create target directories** on Mac (`~/workspaces/atlasresearch/`, etc.)
2. **Move active repos** from `~/Desktop/` to `~/workspaces/` (§3.1)
3. **Evaluate stale clones** — check if branches are merged, remove or convert (§3.1)
4. **Update Sovereign orgs.json** via API or direct file edit (§4)
5. **Update all context files** (§5)
6. **Verify Sovereign loads correctly** — restart server, confirm all orgs/projects resolve
7. **Update Ubuntu machines** via SSH (§3.2, §3.3)
8. **Commit workspace changes** to the OpenClaw workspace repo
9. **Verify OpenClaw** — restart gateway, confirm memory search and context loading work

---

## §7 — Verification

- [ ] All Sovereign orgs resolve to valid directories
- [ ] All Sovereign projects resolve to valid git repos
- [ ] No context file references `~/Desktop/` for repos that have moved
- [ ] No context file references `~/repos/` (empty directory)
- [ ] MEMORY.md contains no stale path references
- [ ] `memory_search` returns correct paths for repo queries
- [ ] Sovereign workspace switcher shows all orgs with correct project counts
- [ ] OpenClaw workspace files load without errors after gateway restart
- [ ] Ubuntu machines have repos at `~/workspaces/<org>/<repo>`
