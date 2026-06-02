// Membranes — types
//
// A *membrane* is Sovereign's abstraction over a social/privacy boundary. It
// groups workspaces (code repos), threads (agent conversations), and
// membrane-scoped artifacts (notes, drafts, planning docs) under a single
// visibility contract.
//
// Key distinction:
//   - `Org` (see @sovereign/orgs) describes a *git provider* container —
//     a GitHub org, a Radicle node, or the local-only `_global` workspace.
//     It maps 1:1 to a filesystem location and a remote provider.
//   - `Membrane` describes a *social context* — who can see this, who
//     collaborates on it, what content does it share. Membranes need NOT
//     map 1:1 to git providers; one membrane can span repos across many
//     orgs, and one repo can belong to multiple membranes.
//
// The mapping (which workspaces belong to which membrane, which membrane
// owns a thread) lives in `~/.sovereign/data/membranes.json` and is pure
// local runtime state — never pushed to any remote.

/**
 * Visibility classification for a membrane. Determines whether its
 * content can be synced beyond the local machine.
 *
 * - `private`: local-only. No sync target. Personal notes, drafts.
 * - `shared`: synced among an explicit set of peers (private remote).
 * - `public`: published openly (public git repo, public Radicle node).
 */
export type MembraneVisibility = 'private' | 'shared' | 'public'

/**
 * How membrane-scoped content (notes/drafts in `contentPath`) is
 * synchronised with other peers. `none` is local-only.
 */
export interface MembraneSyncTarget {
  kind: 'none' | 'git' | 'radicle'
  /** Remote URL for `git`/`radicle` modes. Ignored for `none`. */
  remote?: string
  /** Optional branch (git) / project id (radicle) override. */
  ref?: string
}

/**
 * A single membrane definition.
 */
export interface Membrane {
  /**
   * Stable opaque slug. Used as the foreign key from threads and as the
   * directory name under `~/.sovereign/membranes/<id>/` for content.
   * Renaming the display name does NOT change the id.
   */
  id: string

  /** Human-readable display name. Safe to rename without breaking refs. */
  name: string

  /** Optional one-line description. */
  description?: string

  /** Privacy classification. See `MembraneVisibility`. */
  visibility: MembraneVisibility

  /**
   * Absolute path to the membrane's content directory (notes, drafts,
   * shared planning docs, agent memory). Optional — pure code-grouping
   * membranes may have no content directory.
   *
   * Convention: `<workspaceRoot>/membranes/<id>/` (e.g.
   * `/Users/josh/.sovereign/membranes/personal/`). Code does not enforce
   * this — the path is whatever you point at.
   */
  contentPath?: string

  /**
   * How `contentPath` is synced. Omitted = `{kind:'none'}`.
   */
  syncTarget?: MembraneSyncTarget

  /**
   * Orgs (from @sovereign/orgs `orgs.json`) that belong to this membrane.
   * Many-to-many: one workspace can appear in multiple membranes.
   *
   * Empty array is valid (membrane has no associated code repos — pure
   * notes membrane).
   */
  workspaceIds: string[]

  /** Optional UI hint. Hex colour ("#a855f7") or named token. */
  color?: string

  /** Optional UI hint. Single emoji or short symbol. */
  icon?: string

  createdAt: string
  updatedAt: string
}

/**
 * On-disk shape of `~/.sovereign/data/membranes.json`.
 *
 * Intentionally contains only the structural definition of membranes —
 * UI navigation state (last focused membrane, sidebar collapse, etc.)
 * lives elsewhere so this file stays clean for future sync.
 */
export interface MembranesData {
  /** Schema version. Bump on breaking changes. */
  version: 1
  membranes: Membrane[]
}

/**
 * Patch type for `updateMembrane`. All fields optional; id is immutable.
 */
export type MembranePatch = Partial<Omit<Membrane, 'id' | 'createdAt' | 'updatedAt'>>

/**
 * Input for `createMembrane`. `id` is optional — auto-slugged from name
 * when omitted.
 */
export interface MembraneCreateInput {
  id?: string
  name: string
  description?: string
  visibility?: MembraneVisibility
  contentPath?: string
  syncTarget?: MembraneSyncTarget
  workspaceIds?: string[]
  color?: string
  icon?: string
}
