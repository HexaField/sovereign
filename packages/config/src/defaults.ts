import path from 'node:path'
import type { SovereignConfig } from './types.js'

const home = process.env.HOME ?? ''

export const defaults: SovereignConfig = {
  server: {
    port: 3001,
    host: 'localhost',
    tls: {
      enabled: true
    }
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
  },
  workspace: {
    root: home ? path.join(home, 'workspaces') : '',
    globalPath: ''
  },
  agentBackend: {
    enabled: ['claude-code'],
    default: 'claude-code',
    claudeCode: {
      cwd: '',
      agentDir: home ? path.join(home, '.claude') : '',
      defaultModel: '',
      modelContextWindows: {
        opus: 200000,
        sonnet: 200000,
        haiku: 200000,
        opusplan: 200000
      }
    }
  },
  ad4m: {
    host: '',
    mcpUrl: ''
  },
  voice: {
    transcribeUrl: '',
    ttsUrl: ''
  },
  meetings: {
    summarizeUrl: ''
  },
  identity: {
    agentName: 'Sovereign',
    agentIcon: '⬡'
  },
  models: {
    available: [],
    default: ''
  },
  personality: {
    sourceDir: '',
    files: [],
    separator: '\n\n---\n\n'
  },
  seed: {
    membraneId: 'personal',
    membraneName: 'Personal',
    threadLabel: 'Main'
  }
}
