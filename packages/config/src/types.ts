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
    enabled: ('claude-code' | 'local-llm')[]
    /** Backend chosen when a session has no recorded kind. */
    default: 'claude-code' | 'local-llm'
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
    /** Local LLM backend — connects to any OpenAI-compatible API. */
    localLlm: {
      /** Base URL for the OpenAI-compatible inference server. */
      baseUrl: string
      /** Model identifier sent in chat completion requests. */
      model: string
      /** Maximum context window in tokens. */
      contextWindow: number
      /** Sampling temperature. */
      temperature: number
      /** Maximum output tokens per completion. */
      maxTokens: number
      /** Per-completion timeout in ms. Default 600000 (10 min). */
      timeoutMs: number
      /** Enable model thinking (Qwen3 `<think>` blocks). Default true. */
      thinking: boolean
      /** Tool-call format detection: auto | openai | hermes. */
      toolCallFormat: string
      /** Sandbox restrictions for the Bash tool. */
      sandbox: {
        /** Directories where Bash commands may execute. */
        allowedCwds: string[]
        /** Maximum Bash execution time in ms. */
        bashTimeout: number
      }
    }
  }
  /** Running summary service — maintains per-thread rolling summaries via a local model. */
  summary: {
    enabled: boolean
    /** Base URL for the inference server (same format as localLlm.baseUrl). */
    baseUrl: string
    /** Model identifier for summary generation. */
    model: string
    /** Debounce interval in ms before triggering a summary update. */
    debounceMs: number
    /** Maximum words in a summary. */
    maxSummaryWords: number
  }
  ad4m: {
    /** Empty string means AD4M integration is disabled. */
    host: string
    mcpUrl: string
  }
  voice: {
    transcribeUrl: string
    ttsUrl: string
    /** When true, voice-originated messages receive an immediate TTS
     *  acknowledgment and a spoken summary of the assistant response. */
    autoTts: boolean
    /** Milliseconds to delay ack playback — if the real response arrives
     *  before this window, the ack gets cancelled. Default 1500. */
    ackDelayMs: number
  }
  meetings: {
    summarizeUrl: string
  }
  /**
   * Adjacent LAN/tailnet services (e.g. AD4M dapp launcher, WE web launcher)
   * that Sovereign should surface in the Service Health dropdown. Each entry
   * is polled server-side via `healthUrl`; the browser constructs the outward
   * URL as `http://{window.location.hostname}:{port}{path}` for the "open in
   * new tab" button. Plain HTTP — these live behind Tailscale, not TLS.
   */
  services: {
    external: Array<{
      name: string
      label?: string
      healthUrl: string
      port: number
      path?: string
    }>
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
  /**
   * Context management — three-layer system that keeps agent sessions lean.
   * See plans/context-management.md for the full design.
   */
  contextManagement: {
    /** Layer 1: real-time PostToolUse hook trims/deduplicates tool results. */
    filter: {
      enabled: boolean
      /** Tool results above this byte count get trimmed (head + tail). */
      trimThresholdBytes: number
      /** Maximum lines kept after trimming. */
      trimMaxLines: number
      /** Content blocks at or above this size participate in dedup. */
      dedupMinBytes: number
      /** Strip model signature blocks from tool outputs. */
      stripSignatures: boolean
    }
    /** Layer 2: session recycle — interrupt, prune JSONL, resume. */
    recycle: {
      enabled: boolean
      /** Recycle when context exceeds this % of maxTokens. */
      thresholdPercent: number
      /** Minimum ms between recycles. */
      minIntervalMs: number
      /** Cozempic prescription tier (gentle | standard | aggressive). */
      prescription: string
      /** Skip recycle when subagents run in the session. */
      skipDuringSubagents: boolean
    }
    /** Layer 3: between-session JSONL cleanup via cron. */
    cleanup: {
      enabled: boolean
      /** Sessions above this size (MB) get pruned. */
      maxSessionSizeMB: number
      /** Cron expression for the cleanup schedule. */
      schedule: string
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
