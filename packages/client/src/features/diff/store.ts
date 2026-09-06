import { createSignal } from 'solid-js'

const BASE = typeof import.meta !== 'undefined' ? (import.meta as any).env?.BASE_URL || '/' : '/'

export interface DiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  oldPath?: string
}

export interface GitHubPrInfo {
  number: number
  url: string
  state: string
  title: string
}

export interface CommitInfo {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  refs?: string[]
}

export interface ThreadGitContext {
  repoRoot: string
  repoName: string
  branch: string
  baseBranch: string
  aheadBy: number
  files: DiffFile[]
  commits?: CommitInfo[]
  remote?: { url: string; owner: string; repo: string }
  pr?: GitHubPrInfo
}

export type DiffViewMode = 'unified' | 'split'

// ── Signals ─────────────────────────────────────────────────────────────
const [diffThreadId, setDiffThreadId] = createSignal<string | null>(null)
const [diffViewerOpen, setDiffViewerOpen] = createSignal(false)
const [selectedFile, setSelectedFile] = createSignal<string | null>(null)
const [selectedRepo, setSelectedRepo] = createSignal<string | null>(null)
const [selectedCommit, setSelectedCommit] = createSignal<string | null>(null)
const [diffViewMode, setDiffViewMode] = createSignal<DiffViewMode>('unified')

// ── Fetch helpers ───────────────────────────────────────────────────────
export async function fetchGitContext(threadId: string): Promise<ThreadGitContext[] | null> {
  try {
    const res = await fetch(`${BASE}api/threads/${encodeURIComponent(threadId)}/git-context`)
    if (!res.ok) return null
    const data = await res.json()
    return data.contexts ?? null
  } catch {
    return null
  }
}

export async function fetchFileDiff(
  threadId: string,
  repo: string,
  file?: string,
  commit?: string
): Promise<string | null> {
  try {
    const url = new URL(`${BASE}api/threads/${encodeURIComponent(threadId)}/diff`, window.location.origin)
    url.searchParams.set('repo', repo)
    if (file) url.searchParams.set('file', file)
    if (commit) url.searchParams.set('commit', commit)
    const res = await fetch(url.toString())
    if (!res.ok) return null
    const data = await res.json()
    return data.diff ?? null
  } catch {
    return null
  }
}

// ── Actions ─────────────────────────────────────────────────────────────
export function openDiffViewer(threadId: string): void {
  setDiffThreadId(threadId)
  setSelectedFile(null)
  setSelectedRepo(null)
  setSelectedCommit(null)
  setDiffViewerOpen(true)
}

export function closeDiffViewer(): void {
  setDiffViewerOpen(false)
  setDiffThreadId(null)
  setSelectedFile(null)
  setSelectedRepo(null)
  setSelectedCommit(null)
}

export {
  diffThreadId,
  diffViewerOpen,
  selectedFile,
  setSelectedFile,
  selectedRepo,
  setSelectedRepo,
  selectedCommit,
  setSelectedCommit,
  diffViewMode,
  setDiffViewMode
}
