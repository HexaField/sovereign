// The ports a host implements to run Graphcoder. Graphcoder reaches the code
// index, git, files and a language model only through these; the host (inside
// Sovereign: packages/server/src/graphcoder.ts) supplies them. Paths a port
// takes are absolute checkout paths unless a comment says otherwise.

import type { GraphSnapshot, GraphStats } from './graph.js'

/** One structural index (CodeGraph) per checkout. */
export interface GraphSource {
  /** Absolute paths of the checkouts this source can open: each has an index. */
  list(): Promise<string[]>
  /** Opens a listed checkout's index read-only. Rejects for any other path. The caller closes the handle. */
  open(repoPath: string): Promise<CodeGraphHandle>
}

/** An open, read-only index. Reads are synchronous: the index is a local SQLite file. */
export interface CodeGraphHandle {
  readonly repoPath: string
  stats(): GraphStats
  /** Every node and edge in the index */
  snapshot(): GraphSnapshot
  close(): void
}

/**
 * One `@@ -baseStart,baseLines +headStart,headLines @@` of a zero-context diff. Lines are 1-based. A side with no
 * lines (`baseLines` or `headLines` 0) names the line after which the other side's lines go in or come out.
 */
export interface Hunk {
  baseStart: number
  baseLines: number
  headStart: number
  headLines: number
}

export interface ChangedFile {
  /** Repo-relative path; the new path for a rename */
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  /** The old path of a rename */
  oldPath?: string
  /** The changed lines; empty for a binary file or a pure rename */
  hunks: Hunk[]
}

export interface Commit {
  hash: string
  /** First line of the message */
  message: string
  author: string
  /** ISO 8601 */
  date: string
}

/** A temporary checkout of one ref. `release` removes it; the checkout is never inside the user's repo. */
export interface Checkout {
  path: string
  /** Moves this checkout, detached, to another ref of the same repo (files only; anything untracked stays). */
  switchTo(ref: string): Promise<void>
  release(): Promise<void>
}

export interface GitPort {
  /** The commit a ref names, as a full sha; null when it names none. */
  resolve(repoPath: string, ref: string): Promise<string | null>
  /** The best common ancestor of two commits, as a full sha; null when they share none. */
  mergeBase(repoPath: string, a: string, b: string): Promise<string | null>
  /**
   * Brings refs up to date from the remotes: `<remote>/<branch>` fetches that branch from that remote; a commit
   * sha the repo lacks is fetched from each remote in turn. Anything else is left alone. Rejects when a fetch fails.
   */
  fetch(repoPath: string, refs: string[]): Promise<void>
  /** Files `head` changes since its merge base with `base` (what a pull request from head into base shows). */
  diffRefs(repoPath: string, base: string, head: string): Promise<ChangedFile[]>
  /** Checks `ref` out, detached, into a temporary worktree. */
  checkout(repoPath: string, ref: string): Promise<Checkout>
  /**
   * Commits reachable from HEAD, newest first. `since`: a ref; only commits after it. `paths`: only commits that touch
   * them (repo-relative). `limit`: at most this many.
   */
  log(repoPath: string, opts?: { since?: string; paths?: string[]; limit?: number }): Promise<Commit[]>
}

/** A language model. Graphcoder builds the prompt; the host picks the model. */
export interface AiPort {
  /** The model's reply. `json`: the reply must be one JSON value. */
  complete(prompt: string, opts?: { json?: boolean }): Promise<string>
}

/**
 * Files of one repository, by repo-relative `/`-separated path. Graphcoder's committed data
 * (`.graphcoder/`) and package manifests are read and written through it, so core does no I/O.
 */
export interface RepoFiles {
  /** The file's text, or null when it does not exist */
  read(path: string): Promise<string | null>
  /** Writes the whole file atomically, creating parent directories */
  write(path: string, text: string): Promise<void>
  /** Names of the entries in a directory; empty when it does not exist */
  list(dir: string): Promise<string[]>
  /** Deletes a file; false when it did not exist */
  remove(path: string): Promise<boolean>
}
