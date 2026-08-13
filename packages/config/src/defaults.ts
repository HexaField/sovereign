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
      defaultModel: 'claude-opus-4-6',
      modelContextWindows: {
        opus: 200000,
        sonnet: 200000,
        haiku: 200000,
        opusplan: 200000
      }
    },
    localLlm: {
      baseUrl: 'http://localhost:8080',
      model: 'default',
      contextWindow: 32768,
      temperature: 0.1,
      maxTokens: 4096,
      timeoutMs: 600_000,
      thinking: true,
      toolCallFormat: 'auto',
      sandbox: {
        allowedCwds: [home ? path.join(home, 'workspaces') : ''],
        bashTimeout: 120000
      }
    }
  },
  summary: {
    enabled: false,
    baseUrl: 'http://localhost:8080',
    model: 'default',
    debounceMs: 5000,
    maxSummaryWords: 200
  },
  ad4m: {
    host: '',
    mcpUrl: ''
  },
  voice: {
    transcribeUrl: '',
    ttsUrl: '',
    autoTts: false,
    ackDelayMs: 1500,
    conversationSummary: false
  },
  meetings: {
    summarizeUrl: ''
  },
  services: {
    external: []
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
  },
  contextManagement: {
    filter: {
      enabled: true,
      trimThresholdBytes: 8192,
      trimMaxLines: 100,
      dedupMinBytes: 1024,
      stripSignatures: true
    },
    recycle: {
      enabled: true,
      thresholdPercent: 55,
      minIntervalMs: 300_000,
      prescription: 'standard',
      skipDuringSubagents: true
    },
    cleanup: {
      enabled: true,
      maxSessionSizeMB: 50,
      schedule: '0 4 * * *'
    }
  }
}
