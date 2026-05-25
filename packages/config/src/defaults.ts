import type { SovereignConfig } from './types.js'

export const defaults: SovereignConfig = {
  server: {
    port: 3001,
    host: 'localhost'
  },
  terminal: {
    shell: process.env.SHELL || '/bin/zsh',
    gracePeriodMs: 30000,
    maxSessions: 10
  },
  worktrees: {
    staleDays: 14,
    autoCleanupMerged: false
  },
  projects: {
    defaults: {
      remotes: []
    }
  }
}
