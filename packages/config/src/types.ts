// Config Management — Types

export interface SovereignConfig {
  server: {
    port: number
    host: string
    tls: {
      enabled: boolean
    }
  }
  terminal: {
    shell: string
    gracePeriodMs: number
    maxSessions: number
  }
  worktrees: {
    staleDays: number
    autoCleanupMerged: boolean
  }
  projects: {
    defaults: {
      remotes: string[]
    }
  }
  workspace: {
    /** Default cwd for new Claude Code sessions and file-chip workspace listings. */
    root: string
    /** Filesystem path for the _global org/workspace. Defaults to {dataDir}/orgs/_global at runtime. */
    globalPath: string
  }
  agentBackend: {
    /** Backends to enable on boot. */
    enabled: 'claude-code'[]
    /** Backend chosen when a session has no recorded kind. */
    default: 'claude-code'
    claudeCode: {
      cwd: string
      agentDir: string
      defaultModel: string
      /**
       * Map of model alias → max context window tokens. Drives the
       * "X / 200k" usage display in the chat settings dropdown. Aliases
       * here should match what the SDK accepts (opus, sonnet, haiku,
       * opusplan, or fully-qualified ids).
       */
      modelContextWindows: Record<string, number>
    }
  }
  ad4m: {
    /** Empty string means AD4M integration is disabled. */
    host: string
    mcpUrl: string
  }
  voice: {
    transcribeUrl: string
    ttsUrl: string
  }
  meetings: {
    summarizeUrl: string
  }
  identity: {
    agentName: string
    agentIcon: string
  }
  models: {
    /** Optional curated list shown in the system view. Empty array = no curation. */
    available: string[]
    /** Optional default model identifier; empty string means "use backend default". */
    default: string
  }
  /**
   * Personality compiler — assembles `~/.claude/CLAUDE.md` (the user-global
   * Claude Code system prompt) by concatenating per-concern Markdown source
   * files in the order declared here. Output is an exact concatenation:
   * `files.map(read).join(separator)`.
   *
   * Compiler is a no-op when `files` is empty.
   */
  personality: {
    /** Directory holding the source `.md` files. Empty string falls back to {workspace.root}. */
    sourceDir: string
    /** Source files in assembly order. CLAUDE.md is refused (it's the output target). */
    files: string[]
    /** String inserted between concatenated source bodies. */
    separator: string
  }
  /**
   * First-boot seed. The runtime makes NO standing assumptions about which
   * threads or membranes exist — these values describe the single default
   * membrane + thread created on a fresh install so the UI is usable out of
   * the box. Set any field to an empty string to opt out of that piece.
   *
   * - `membraneId`/`membraneName`: a default membrane is auto-created on boot
   *   if `membraneId` is non-empty and no membrane with that id exists yet.
   *   Empty `membraneId` ⇒ no membrane is created and the seed thread is left
   *   unassigned.
   * - `threadLabel`: a single thread with this label is created only when the
   *   thread registry is completely empty. Empty ⇒ no thread is seeded.
   */
  seed: {
    membraneId: string
    membraneName: string
    threadLabel: string
  }
}

export interface ConfigChange {
  timestamp: string
  path: string
  oldValue: unknown
  newValue: unknown
  source: 'api' | 'file' | 'env' | 'startup'
}

export interface ConfigStore {
  get<T = unknown>(path?: string): T
  set(path: string, value: unknown): void
  patch(partial: Record<string, unknown>): void
  /** Public-only subset of config — safe to return to unauthenticated clients. */
  getPublic(): { identity: SovereignConfig['identity']; models: SovereignConfig['models'] }
  getSchema(): object
  getHistory(opts?: { limit?: number; offset?: number }): ConfigChange[]
  exportConfig(): SovereignConfig
  importConfig(config: unknown): void
  onChange(path: string, handler: (change: ConfigChange) => void): () => void
  /** Read a secret by dot-path. Returns empty string if unset. */
  getSecret(path: string): string
  /** Write a secret. Empty string clears it. */
  setSecret(path: string, value: string): void
  status(): import('@sovereign/core').ModuleStatus
}
