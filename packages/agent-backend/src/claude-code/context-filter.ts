// Context Filter — Layer 1 of context management.
//
// Intercepts tool results via the PostToolUse hook and trims/deduplicates
// content before it enters the model's context window. Operates entirely
// in real time — no batch processing, no JSONL rewriting.

import { createHash } from 'node:crypto'

export interface ContextFilterConfig {
  enabled: boolean
  /** Tool results above this byte count get trimmed (head + tail). */
  trimThresholdBytes: number
  /** Maximum lines kept after trimming (half head, half tail). */
  trimMaxLines: number
  /** Content blocks at or above this size participate in dedup. */
  dedupMinBytes: number
  /** Strip model signature blocks from tool outputs. */
  stripSignatures: boolean
}

export const CONTEXT_FILTER_DEFAULTS: ContextFilterConfig = {
  enabled: true,
  trimThresholdBytes: 8192,
  trimMaxLines: 40,
  dedupMinBytes: 1024,
  stripSignatures: true
}

/** Signature patterns — model-generated footer blocks echoed via tool results. */
const SIGNATURE_PATTERNS = [
  /\n---\n\*?(?:Generated|Created|Co-Authored)[^\n]*$/s,
  /\n🤖 Generated with \[Claude Code\]\([^)]*\)\s*$/s,
  /\nCo-Authored-By: Claude[^\n]*$/s
]

export function createContextFilter(initialConfig?: Partial<ContextFilterConfig>) {
  const cfg: ContextFilterConfig = { ...CONTEXT_FILTER_DEFAULTS, ...initialConfig }
  /** MD5 → first-seen turn index. Blocks seen before get stubbed. */
  const seenHashes = new Map<string, number>()
  let turnCounter = 0

  // Telemetry counters — accumulate for the lifetime of the session (NOT
  // cleared by `reset()`, which only clears dedup state on recycle). Exposed
  // via `stats()` for observability into how much the filter is reclaiming.
  let trimCount = 0
  let trimBytesReclaimed = 0
  let dedupCount = 0
  let dedupBytesReclaimed = 0
  let signatureStripCount = 0

  function md5(text: string): string {
    return createHash('md5').update(text).digest('hex')
  }

  /**
   * Trim a string to head + tail lines when it exceeds the byte threshold.
   * Returns the original if under threshold.
   */
  function trimLargeOutput(text: string): string {
    const originalBytes = Buffer.byteLength(text, 'utf-8')
    if (originalBytes <= cfg.trimThresholdBytes) return text
    const lines = text.split('\n')
    if (lines.length <= cfg.trimMaxLines) return text
    const halfLines = Math.floor(cfg.trimMaxLines / 2)
    const head = lines.slice(0, halfLines)
    const tail = lines.slice(-halfLines)
    const trimmedCount = lines.length - cfg.trimMaxLines
    const result = [...head, `\n[... ${trimmedCount} lines trimmed by context filter ...]\n`, ...tail].join('\n')
    trimCount++
    trimBytesReclaimed += originalBytes - Buffer.byteLength(result, 'utf-8')
    return result
  }

  /** Strip signature blocks from the end of a string. */
  function stripSignatures(text: string): string {
    if (!cfg.stripSignatures) return text
    let result = text
    for (const pattern of SIGNATURE_PATTERNS) {
      const before = result
      result = result.replace(pattern, '')
      if (result !== before) signatureStripCount++
    }
    return result
  }

  /**
   * Deduplicate a content block. If the block (at or above dedupMinBytes)
   * was seen before, replace it with a short stub. Returns the original
   * on first encounter.
   */
  function dedup(text: string): string {
    if (Buffer.byteLength(text, 'utf-8') < cfg.dedupMinBytes) return text
    const hash = md5(text)
    const firstSeen = seenHashes.get(hash)
    if (firstSeen !== undefined) {
      const stub = `[duplicate content — first seen at turn ${firstSeen}, ${text.length} chars omitted]`
      dedupCount++
      dedupBytesReclaimed += text.length - stub.length
      return stub
    }
    seenHashes.set(hash, turnCounter)
    return text
  }

  /**
   * Run the strip → dedup → trim chain on a single text string.
   * Returns the original reference when nothing changed.
   */
  function filterText(text: string): string {
    let filtered = stripSignatures(text)
    filtered = dedup(filtered)
    filtered = trimLargeOutput(filtered)
    return filtered
  }

  /**
   * Extract the primary text field from a structured tool-output object,
   * filter it, and return the rebuilt object. Returns `null` when the
   * output requires no modification.
   *
   * The SDK's built-in tools each return a typed object (BashOutput,
   * FileReadOutput, GrepOutput, etc.) — never a bare string. This
   * function handles each known shape so the filter actually fires.
   */
  function filterStructuredOutput(toolName: string, output: Record<string, unknown>): unknown | null {
    switch (toolName) {
      // Bash → { stdout: string, stderr: string, ... }
      case 'Bash': {
        let changed = false
        const result = { ...output }
        if (typeof output.stdout === 'string') {
          const filtered = filterText(output.stdout as string)
          if (filtered !== output.stdout) {
            result.stdout = filtered
            changed = true
          }
        }
        if (typeof output.stderr === 'string') {
          const filtered = filterText(output.stderr as string)
          if (filtered !== output.stderr) {
            result.stderr = filtered
            changed = true
          }
        }
        return changed ? result : null
      }

      // Read → { type: 'text', file: { content: string, ... }, ... }
      case 'Read': {
        const file = output.file as Record<string, unknown> | undefined
        if (output.type !== 'text' || !file || typeof file.content !== 'string') return null
        const filtered = filterText(file.content as string)
        if (filtered === file.content) return null
        return { ...output, file: { ...file, content: filtered } }
      }

      // Grep → { content?: string, filenames: string[], ... }
      case 'Grep': {
        if (typeof output.content !== 'string') return null
        const filtered = filterText(output.content as string)
        if (filtered === output.content) return null
        return { ...output, content: filtered }
      }

      // Edit / Write → { content?: string, ... }
      case 'Edit':
      case 'Write': {
        if (typeof output.content !== 'string') return null
        const filtered = filterText(output.content as string)
        if (filtered === output.content) return null
        return { ...output, content: filtered }
      }

      // Agent / Task subagent results → { content: [{ type, text }], ... }
      case 'Agent':
      case 'Task': {
        if (!Array.isArray(output.content)) return null
        return filterContentArray(output.content as unknown[]) ? { ...output, content: output.content } : null
      }

      default:
        return null
    }
  }

  /**
   * Filter an array of content blocks in place. Returns true when at
   * least one block changed.
   */
  function filterContentArray(blocks: unknown[]): boolean {
    let changed = false
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as Record<string, unknown> | null
      if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
      const filtered = filterText(block.text as string)
      if (filtered !== block.text) {
        blocks[i] = { ...block, text: filtered }
        changed = true
      }
    }
    return changed
  }

  /**
   * Process a tool result through the filter chain:
   *   1. Signature strip
   *   2. Dedup
   *   3. Trim large outputs
   *
   * Returns `null` when the output requires no modification (caller should
   * NOT set updatedToolOutput in that case — the SDK uses the original).
   */
  function filterToolOutput(toolName: string, output: unknown): unknown | null {
    if (!cfg.enabled) return null

    // String output — MCP tool results arrive as plain strings.
    if (typeof output === 'string') {
      const filtered = filterText(output)
      return filtered !== output ? filtered : null
    }

    // Structured content array — `[{ type: 'text', text: '...' }, ...]`
    if (Array.isArray(output)) {
      const copy = [...output]
      return filterContentArray(copy) ? copy : null
    }

    // Structured tool-output objects (Bash, Read, Grep, Edit, etc.).
    if (typeof output === 'object' && output !== null) {
      return filterStructuredOutput(toolName, output as Record<string, unknown>)
    }

    return null
  }

  /** Advance the turn counter. Call once per assistant turn. */
  function advanceTurn(): void {
    turnCounter++
  }

  /** Reset dedup state. Call on session recycle. Telemetry counters are
   *  intentionally NOT reset here — they accumulate across the session's
   *  full lifetime so `stats()` reflects total reclaim, not just since the
   *  last recycle. */
  function reset(): void {
    seenHashes.clear()
    turnCounter = 0
  }

  /** Live-update configuration (hot-reload from configStore). */
  function updateConfig(patch: Partial<ContextFilterConfig>): void {
    Object.assign(cfg, patch)
  }

  /** Snapshot of accumulated filter telemetry, for observability. */
  function stats(): {
    trimCount: number
    trimBytesReclaimed: number
    dedupCount: number
    dedupBytesReclaimed: number
    signatureStripCount: number
    seenHashes: number
    turnCounter: number
  } {
    return {
      trimCount,
      trimBytesReclaimed,
      dedupCount,
      dedupBytesReclaimed,
      signatureStripCount,
      seenHashes: seenHashes.size,
      turnCounter
    }
  }

  return { filterToolOutput, advanceTurn, reset, updateConfig, stats }
}

export type ContextFilter = ReturnType<typeof createContextFilter>
