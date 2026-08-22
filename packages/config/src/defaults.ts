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
      reasoning: {
        enabled: false,
        effort: 'medium' as const,
        maxTokens: 2048
      },
      toolCallFormat: 'auto',
      sandbox: {
        allowedCwds: [home ? path.join(home, 'workspaces') : ''],
        bashTimeout: 120000
      },
      endpoints: []
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
    conversationSummary: false,
    prompts: {
      ackSystem: [
        'You generate brief spoken acknowledgments for a voice assistant.',
        "Given the user's message and recent conversation context, produce a single short sentence",
        'confirming you received the request and will work on it. Include a tiny amount of context',
        'from the request so the user knows you understood.',
        '',
        'Rules:',
        '- One sentence only, under 20 words.',
        '- Never use markdown, code, or special formatting.',
        '- Speak naturally as a calm, competent assistant.',
        '',
        'Examples:',
        '- "Looking into the build logs now."',
        '- "Running that analysis for you now."',
        '- "Checking on the deployment status."',
        '- "On it — pulling up the test results now."'
      ].join('\n'),
      summarySystem: [
        'You summarize assistant responses into brief spoken language for a voice assistant.',
        "Convert the assistant's written response into a concise spoken summary suitable for text-to-speech.",
        '',
        'Rules:',
        '- Keep it under 3 sentences for short responses, under 5 for longer ones.',
        '- Strip ALL markdown, code blocks, URLs, file paths, and technical formatting.',
        '- Rephrase code-heavy content as plain descriptions of what happened.',
        '- Speak naturally — this gets read aloud.',
        '- If the response contains a list of items, mention the count and highlight the most important ones.',
        '- For error reports, state what failed and what to do next.'
      ].join('\n'),
      conversationSummarySystem: [
        'You maintain a running summary of a conversation between a user and their AI assistant.',
        'Given the previous summary and the latest exchange (user message + assistant response),',
        'produce an updated summary that captures the key points, decisions, and current state.',
        '',
        'Rules:',
        '- Keep under 4 sentences.',
        '- Focus on what happened, what got decided, and what remains open.',
        '- Never use markdown, code, or special formatting.',
        '- Write in third person ("The user asked...", "The assistant implemented...").'
      ].join('\n')
    }
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
