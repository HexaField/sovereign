// Config Management — Types

export interface SovereignConfig {
  server: {
    port: number
    host: string
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
  getSchema(): object
  getHistory(opts?: { limit?: number; offset?: number }): ConfigChange[]
  exportConfig(): SovereignConfig
  importConfig(config: unknown): void
  onChange(path: string, handler: (change: ConfigChange) => void): () => void
  status(): import('@sovereign/core').ModuleStatus
}
