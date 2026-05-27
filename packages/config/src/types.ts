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
    /** Backends to enable on boot. Comma-separated env value used to be SOVEREIGN_ENABLED_BACKENDS. */
    enabled: ('openclaw' | 'claude-code')[]
    /** Backend chosen when a session has no recorded kind. */
    default: 'openclaw' | 'claude-code'
    openclaw: {
      gatewayUrl: string
    }
    claudeCode: {
      cwd: string
      agentDir: string
      defaultModel: string
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
