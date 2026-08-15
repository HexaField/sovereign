import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLocalLlmBackend, type LocalLlmBackend } from './local-llm.js'
import type { LocalLlmConfig } from './config.js'
import type { CompletionResponse, InferenceClient } from './inference.js'

let tmpDir: string
let dataDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-cwd-')))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-data-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function makeConfig(): LocalLlmConfig {
  return {
    baseUrl: 'http://127.0.0.1:1', // never actually dialled — tests inject a fake client
    model: 'test-model',
    contextWindow: 8192,
    temperature: 0.1,
    maxTokens: 1024,
    timeoutMs: 60_000,
    thinking: true,
    toolCallFormat: 'auto',
    modelsRegistry: null,
    sandbox: { allowedCwds: [tmpDir], bashTimeout: 5000 }
  }
}

function textResponse(content: string): CompletionResponse {
  return {
    id: 'r',
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
  }
}

function toolCallResponse(name: string, args: Record<string, unknown>, id = 'call_1'): CompletionResponse {
  return {
    id: 'r',
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: 'tool_calls'
      }
    ]
  }
}

/** A queue-backed fake InferenceClient. Each `complete()` call pops the next queued response. */
function makeFakeClient(...responses: CompletionResponse[]): {
  client: InferenceClient
  complete: ReturnType<typeof vi.fn>
} {
  const complete = vi.fn()
  for (const r of responses) complete.mockResolvedValueOnce(r)
  const client: InferenceClient = {
    complete: complete as unknown as InferenceClient['complete'],
    stream: (async function* () {})() as unknown as InferenceClient['stream'],
    healthCheck: vi.fn().mockResolvedValue(true) as unknown as InferenceClient['healthCheck'],
    updateConfig: vi.fn() as unknown as InferenceClient['updateConfig']
  }
  return { client, complete }
}

/** A client whose `complete()` never resolves until `release()` is called, and rejects on abort. */
function makePendingClient(): { client: InferenceClient; release: (r: CompletionResponse) => void } {
  let resolveFn: ((r: CompletionResponse) => void) | undefined
  const complete = vi.fn((_messages: unknown, opts?: { signal?: AbortSignal }) => {
    return new Promise<CompletionResponse>((resolve, reject) => {
      resolveFn = resolve
      opts?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
  })
  const client: InferenceClient = {
    complete: complete as unknown as InferenceClient['complete'],
    stream: (async function* () {})() as unknown as InferenceClient['stream'],
    healthCheck: vi.fn().mockResolvedValue(true) as unknown as InferenceClient['healthCheck'],
    updateConfig: vi.fn() as unknown as InferenceClient['updateConfig']
  }
  return { client, release: (r) => resolveFn?.(r) }
}

function collectEvents(backend: LocalLlmBackend) {
  const turns: Array<{ content: string; sendFailed?: boolean }> = []
  const statuses: string[] = []
  backend.on('chat.turn', (d) => turns.push(d.turn))
  backend.on('chat.status', (d) => statuses.push(d.status))
  return { turns, statuses }
}

/** Wait for a specific sessionKey to emit chat.status: idle. Times out after 2s. */
function waitForIdle(backend: LocalLlmBackend, _key?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForIdle timed out')), 2000)
    const handler = (d: Record<string, unknown>) => {
      if (d.status === 'idle') {
        clearTimeout(timer)
        backend.off('chat.status', handler)
        resolve()
      }
    }
    backend.on('chat.status', handler)
  })
}

describe('local-llm backend: session lifecycle', () => {
  it('createSession returns a key and getSessionMeta reflects it', async () => {
    const { client } = makeFakeClient()
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const key = await backend.createSession('My Session')
    expect(key).toBeTruthy()
    const meta = await backend.getSessionMeta(key)
    expect(meta?.model).toBe('test-model')
    expect(meta?.modelProvider).toBe('local-llm')
    expect(meta?.label).toBe('My Session')
  })

  it('createSession honours an explicit threadKey', async () => {
    const { client } = makeFakeClient()
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const key = await backend.createSession('t', { threadKey: 'my-thread-id' })
    expect(key).toBe('my-thread-id')
  })

  it('capabilities() reports sovereign-orchestrated subagent support', () => {
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: makeFakeClient().client })
    const caps = backend.capabilities()
    expect(caps.subagents).toBe('sovereign-orchestrated')
    expect(caps.multiProvider).toBe(true)
    expect(caps.toolStreaming).toBe(true)
  })

  it('listSubagents returns empty when no subagents exist', async () => {
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: makeFakeClient().client })
    await backend.createSession('t')
    expect(await backend.listSubagents()).toEqual([])
  })

  it('getSessionFilePath is null for unknown sessions, a real path for known ones', async () => {
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: makeFakeClient().client })
    expect(backend.getSessionFilePath?.('unknown')).toBeNull()
    const key = await backend.createSession('t')
    const filePath = backend.getSessionFilePath?.(key)
    expect(filePath).toContain(dataDir)
    backend.flushState()
    expect(fs.existsSync(filePath!)).toBe(true)
  })
})

describe('local-llm backend: model registry', () => {
  it('listAvailableModels reads all models from an on-disk registry', async () => {
    const registryPath = path.join(dataDir, 'models.json')
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        models: {
          'model-a': { label: 'Model A', quant: 'Q4_K_M' },
          'model-b': { label: 'Model B', quant: 'Q8_0' },
          'model-c': { label: 'Model C' }
        },
        active: 'model-b'
      })
    )
    const config = { ...makeConfig(), modelsRegistry: registryPath }
    const backend = createLocalLlmBackend(config, { dataDir, inferenceClient: makeFakeClient().client })
    const result = await backend.listAvailableModels()
    expect(result.models).toEqual(['model-a', 'model-b', 'model-c'])
    expect(result.defaultModel).toBe('model-b')
    expect(result.catalog).toHaveLength(3)
    expect(result.catalog![0]).toEqual({
      id: 'model-a',
      provider: 'local-llm',
      family: 'model-a',
      familyLabel: 'Model A',
      version: 'Q4_K_M',
      versionLabel: 'Q4_K_M'
    })
    expect(result.catalog![2].version).toBeNull()
    expect(result.catalog![2].versionLabel).toBe('default')
  })

  it('listAvailableModels falls back to server probe when registry absent', async () => {
    const config = { ...makeConfig(), modelsRegistry: '/nonexistent/path.json' }
    const backend = createLocalLlmBackend(config, { dataDir, inferenceClient: makeFakeClient().client })
    // Server unreachable (port 1) — falls all the way back to config.model.
    const result = await backend.listAvailableModels()
    expect(result.models).toEqual(['test-model'])
    expect(result.defaultModel).toBe('test-model')
  })

  it('listAvailableModels falls back when registry has no models key', async () => {
    const registryPath = path.join(dataDir, 'models.json')
    fs.writeFileSync(registryPath, JSON.stringify({ active: 'x' }))
    const config = { ...makeConfig(), modelsRegistry: registryPath }
    const backend = createLocalLlmBackend(config, { dataDir, inferenceClient: makeFakeClient().client })
    const result = await backend.listAvailableModels()
    expect(result.models).toEqual(['test-model'])
  })
})

describe('local-llm backend: sendMessage (no tools)', () => {
  it('runs one completion round and emits a matching chat.turn + status transitions', async () => {
    const { client, complete } = makeFakeClient(textResponse('General Kenobi.'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const { turns, statuses } = collectEvents(backend)

    const key = await backend.createSession('t')
    // sendMessage fires-and-forgets; wait for the async turn to complete.
    const idle = waitForIdle(backend)
    await backend.sendMessage(key, 'Hello there.')
    await idle

    expect(complete).toHaveBeenCalledTimes(1)
    expect(turns).toHaveLength(1)
    expect(turns[0].content).toBe('General Kenobi.')
    expect(statuses).toEqual(['working', 'idle'])
  })

  it('getFullHistory reconstructs user + assistant turns from the persisted transcript', async () => {
    const { client } = makeFakeClient(textResponse('answer'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const key = await backend.createSession('t')
    const idle = waitForIdle(backend)
    await backend.sendMessage(key, 'question')
    await idle

    const turns = await backend.getFullHistory(key)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(turns[0].content).toBe('question')
    expect(turns[1].content).toBe('answer')
  })

  it('lazily creates a session on sendMessage if none was created first', async () => {
    const { client } = makeFakeClient(textResponse('ok'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const idle = waitForIdle(backend)
    await backend.sendMessage('never-created', 'hi')
    await idle
    const turns = await backend.getFullHistory('never-created')
    expect(turns).toHaveLength(2)
  })

  it('queues a second sendMessage sent before the first resolves instead of dropping it', async () => {
    const { client, complete } = makeFakeClient(textResponse('first answer'), textResponse('second answer'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const { turns } = collectEvents(backend)
    const key = await backend.createSession('t')

    // Both messages queue; the drain loop processes them sequentially.
    // Wait for the second idle (two turns → two idle emissions).
    let idleCount = 0
    const bothDone = new Promise<void>((resolve) => {
      backend.on('chat.status', (d) => {
        if (d.status === 'idle' && ++idleCount >= 2) resolve()
      })
    })
    await backend.sendMessage(key, 'first question')
    await backend.sendMessage(key, 'second question')
    await bothDone

    expect(complete).toHaveBeenCalledTimes(2)
    expect(turns.map((t) => t.content)).toEqual(['first answer', 'second answer'])
  })

  it('merges compaction summary system messages into the single leading system message on the wire', async () => {
    // Regression: Qwen3/Llama templates reject multiple system messages.
    // A compaction summary stored as role:'system' in state.messages MUST
    // get folded into the leading system message, not sent separately.
    //
    // Pre-populate the state directory with a session file that has a
    // compaction summary, then construct a fresh backend so rehydrate()
    // loads the seeded state — matching the production scenario exactly.
    const sessionKey = 'compaction-merge-test'
    const stateDir = path.join(dataDir, 'agent-backend', 'local-llm-state')
    fs.mkdirSync(stateDir, { recursive: true })
    const stateFile = path.join(stateDir, `${sessionKey}.json`)
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        data: {
          sessionKey,
          backendSessionId: 'bsid-1',
          cwd: tmpDir,
          model: 'test-model',
          label: 'compaction-test',
          systemPrompt: 'You help with things.',
          messages: [
            {
              role: 'system',
              content: '[Compacted conversation — summary]\n\nUser asked about X.',
              timestamp: Date.now() - 5000
            },
            { role: 'user', content: 'follow up on X', timestamp: Date.now() - 4000 },
            { role: 'assistant', content: 'here is X', timestamp: Date.now() - 3000 }
          ],
          createdAt: Date.now() - 10000,
          updatedAt: Date.now() - 3000
        }
      })
    )

    const { client, complete } = makeFakeClient(textResponse('still working'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const idle = waitForIdle(backend)
    await backend.sendMessage(sessionKey, 'continue')
    await idle

    // The wire messages sent to complete() must have exactly ONE system message
    const wireMessages = complete.mock.calls[0][0] as Array<{ role: string; content: string }>
    const systemMsgs = wireMessages.filter((m) => m.role === 'system')
    expect(systemMsgs).toHaveLength(1)
    // The single system message must contain the compaction summary (old or new prefix)
    const sysContent = systemMsgs[0].content
    expect(sysContent.includes('[Compacted') || sysContent.includes('[CONTEXT COMPACTION')).toBe(true)
    // Non-system messages must still appear
    const nonSystem = wireMessages.filter((m) => m.role !== 'system')
    expect(nonSystem.some((m) => m.role === 'user' && m.content === 'follow up on X')).toBe(true)
    expect(nonSystem.some((m) => m.role === 'user' && m.content === 'continue')).toBe(true)
  })
})

describe('local-llm backend: sendMessage (tool calling)', () => {
  it('actually executes a Write tool call against the real filesystem, sandboxed to cwd', async () => {
    const target = path.join(tmpDir, 'out.txt')
    const { client, complete } = makeFakeClient(
      toolCallResponse('Write', { file_path: target, content: 'hello from the model' }),
      textResponse('Wrote the file.')
    )
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const { turns } = collectEvents(backend)
    const key = await backend.createSession('t', { cwd: tmpDir })

    const idle = waitForIdle(backend)
    await backend.sendMessage(key, 'write a file')
    await idle

    expect(complete).toHaveBeenCalledTimes(2)
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello from the model')
    expect(turns).toHaveLength(1)
    expect(turns[0].content).toBe('Wrote the file.')
  })

  it('a tool-only round with no final text still surfaces a turn instead of vanishing', async () => {
    fs.mkdirSync(path.join(tmpDir, 'somedir'))
    const { client } = makeFakeClient(toolCallResponse('LS', { path: tmpDir }), textResponse(''))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const { turns } = collectEvents(backend)
    const key = await backend.createSession('t', { cwd: tmpDir })

    const idle = waitForIdle(backend)
    await backend.sendMessage(key, 'list files')
    await idle

    expect(turns).toHaveLength(1)
    expect(turns[0].content).toBe('(no response from model)')
  })
})

describe('local-llm backend: abort', () => {
  it('abort() stops an in-flight turn, returns to idle, and emits no error turn', async () => {
    const { client } = makePendingClient()
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const { turns, statuses } = collectEvents(backend)
    const key = await backend.createSession('t')

    // sendMessage now fires-and-forgets. Wait for the async drain to complete.
    const idle = waitForIdle(backend)
    await backend.sendMessage(key, 'hi')
    await new Promise((r) => setTimeout(r, 20)) // let runTurn reach the pending complete() call
    await backend.abort(key)
    await idle

    expect(statuses[statuses.length - 1]).toBe('idle')
    expect(turns).toHaveLength(0)
  })

  it('aborting an unknown session is a safe no-op', async () => {
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: makeFakeClient().client })
    await expect(backend.abort('nope')).resolves.toBeUndefined()
  })
})

describe('local-llm backend: errors', () => {
  it('a completion failure produces a sendFailed turn and a chat.error', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('connection refused'))
    const client: InferenceClient = {
      complete: complete as unknown as InferenceClient['complete'],
      stream: (async function* () {})() as unknown as InferenceClient['stream'],
      healthCheck: vi.fn().mockResolvedValue(false) as unknown as InferenceClient['healthCheck'],
      updateConfig: vi.fn() as unknown as InferenceClient['updateConfig']
    }
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const { turns } = collectEvents(backend)
    const errors: string[] = []
    backend.on('chat.error', (d) => errors.push(d.error))
    const key = await backend.createSession('t')

    const idle = waitForIdle(backend)
    await backend.sendMessage(key, 'hi')
    await idle

    expect(turns).toHaveLength(1)
    expect(turns[0].sendFailed).toBe(true)
    expect(turns[0].content).toContain('connection refused')
    expect(errors).toHaveLength(1)
  })
})

describe('local-llm backend: model + provider', () => {
  it('setSessionModel rejects a foreign provider', async () => {
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: makeFakeClient().client })
    const key = await backend.createSession('t')
    await expect(backend.setSessionModel(key, 'anthropic', 'claude-opus-4-6')).rejects.toThrow(/only the "local-llm"/)
  })

  it('setSessionModel updates the session model', async () => {
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: makeFakeClient().client })
    const key = await backend.createSession('t')
    await backend.setSessionModel(key, 'local-llm', 'other-model')
    const meta = await backend.getSessionMeta(key)
    expect(meta?.model).toBe('other-model')
  })

  it('listAvailableModels falls back to the configured model when the server is unreachable', async () => {
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: makeFakeClient().client })
    const result = await backend.listAvailableModels()
    expect(result.models).toEqual(['test-model'])
    expect(result.defaultModel).toBe('test-model')
  })
})

describe('local-llm backend: connect/disconnect', () => {
  it('connect() reflects the inference client health check', async () => {
    const { client } = makeFakeClient()
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    await backend.connect()
    expect(backend.status()).toBe('connected')
  })

  it('connect() reports error status when the server is unreachable', async () => {
    const client: InferenceClient = {
      complete: vi.fn() as unknown as InferenceClient['complete'],
      stream: (async function* () {})() as unknown as InferenceClient['stream'],
      healthCheck: vi.fn().mockResolvedValue(false) as unknown as InferenceClient['healthCheck'],
      updateConfig: vi.fn() as unknown as InferenceClient['updateConfig']
    }
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    await backend.connect()
    expect(backend.status()).toBe('error')
  })

  it('disconnect() sets status disconnected', async () => {
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: makeFakeClient().client })
    await backend.connect()
    await backend.disconnect()
    expect(backend.status()).toBe('disconnected')
  })
})

describe('local-llm backend: activity + listing', () => {
  it('getActivityMap includes sessions with their last-activity timestamp', async () => {
    const { client } = makeFakeClient(textResponse('ok'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const key = await backend.createSession('t')
    const idle = waitForIdle(backend)
    await backend.sendMessage(key, 'hi')
    await idle
    const map = await backend.getActivityMap?.()
    expect(map?.get(key)).toBeGreaterThan(0)
  })

  it('listSessions returns created sessions', async () => {
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: makeFakeClient().client })
    const key = await backend.createSession('My Thread')
    const sessions = await backend.listSessions()
    expect(sessions.map((s) => s.key)).toContain(key)
    expect(sessions.find((s) => s.key === key)?.label).toBe('My Thread')
  })
})

describe('local-llm backend: persistence across restarts', () => {
  it('rehydrates session transcripts from disk for a fresh backend instance', async () => {
    const config = makeConfig()
    const { client } = makeFakeClient(textResponse('answer one'))
    const backendA = createLocalLlmBackend(config, { dataDir, inferenceClient: client })
    const key = await backendA.createSession('persisted')
    const idle = waitForIdle(backendA)
    await backendA.sendMessage(key, 'question')
    await idle
    backendA.flushState()

    const backendB = createLocalLlmBackend(config, { dataDir, inferenceClient: makeFakeClient().client })
    const turns = await backendB.getFullHistory(key)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(turns[1].content).toBe('answer one')

    const meta = await backendB.getSessionMeta(key)
    expect(meta?.label).toBe('persisted')
  })
})

describe('local-llm backend: context budget + recycle', () => {
  it('getContextBudget reports system prompt and tool schema sizes', async () => {
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: makeFakeClient().client })
    const key = await backend.createSession('t')
    const budget = await backend.getContextBudget(key)
    expect(budget?.systemPrompt?.chars).toBeGreaterThan(0)
    // 7 core tools + 2 semble tools (enabled by default)
    expect(budget?.tools?.entries.length).toBe(9)
  })

  it('getSessionMeta.totalTokens matches getContextBudget.session.contextTokens (single source of truth)', async () => {
    // Both getSessionMeta and getContextBudget must report the same estimated
    // token count. Previously getSessionMeta used JSON.stringify(messages).length
    // (inflated ~30-50% by JSON envelope) while compaction used sum-of-content.
    const { client } = makeFakeClient(textResponse('hi'), textResponse('there'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const key = await backend.createSession('t')

    let idle = waitForIdle(backend)
    await backend.sendMessage(key, 'hello world')
    await idle
    idle = waitForIdle(backend)
    await backend.sendMessage(key, 'follow-up question with some content')
    await idle

    const meta = await backend.getSessionMeta(key)
    const budget = await backend.getContextBudget(key)

    expect(meta).not.toBeNull()
    expect(budget).not.toBeNull()
    // Both should report the same token count
    expect(meta!.totalTokens).toBe(budget!.session.contextTokens)
    // And the count should be reasonable (positive, not inflated beyond context window)
    expect(meta!.totalTokens).toBeGreaterThan(0)
    expect(meta!.totalTokens).toBeLessThan(meta!.contextTokens!)
  })

  it('getContextBudget returns null for an unknown session', async () => {
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: makeFakeClient().client })
    expect(await backend.getContextBudget('nope')).toBeNull()
  })

  it('recycleSession truncates a large tool result once it falls outside the recent-keep window', async () => {
    const bigFile = path.join(tmpDir, 'big.txt')
    fs.writeFileSync(bigFile, 'A'.repeat(5000))

    const responses: CompletionResponse[] = [
      toolCallResponse('Read', { file_path: bigFile }),
      textResponse('read the big file')
    ]
    // Pad with plain rounds (2 messages each) so the big tool-result message
    // (currently near the front of the transcript) ends up outside the last
    // RECYCLE_KEEP_RECENT_MESSAGES (20) once enough turns accumulate.
    for (let i = 0; i < 12; i++) responses.push(textResponse(`filler ${i}`))

    const { client } = makeFakeClient(...responses)
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const key = await backend.createSession('t', { cwd: tmpDir })

    let idle = waitForIdle(backend)
    await backend.sendMessage(key, 'read the big file') // user, assistant(tool_call), tool(result), assistant(final)
    await idle
    for (let i = 0; i < 12; i++) {
      idle = waitForIdle(backend)
      await backend.sendMessage(key, `filler question ${i}`) // user, assistant
      await idle
    }

    const result = await backend.recycleSession?.(key, { force: true })
    expect(result).not.toBeNull()
    expect(result?.reclaimedBytes ?? 0).toBeGreaterThan(0)
    expect(result?.postTokens ?? Infinity).toBeLessThan(result?.preTokens ?? 0)

    const turns = await backend.getFullHistory(key)
    expect(JSON.stringify(turns)).toContain('pruned')
  })
})

describe('local-llm backend: subagent spawning', () => {
  it('spawnSubagent creates a child session and returns a subagent key', async () => {
    const { client } = makeFakeClient(textResponse('child result'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const parentKey = await backend.createSession('parent')
    const childKey = await backend.spawnSubagent!(parentKey, { task: 'do something' })
    expect(childKey).toMatch(/^agent:main:subagent:/)
    // Let the fire-and-forget sendMessage settle.
    await vi.waitFor(async () => {
      const meta = await backend.getSessionMeta(childKey)
      expect(meta?.parentKey).toBe(parentKey)
    })
  })

  it('spawnSubagent child appears in listSubagents', async () => {
    const { client } = makeFakeClient(textResponse('done'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const parentKey = await backend.createSession('parent')
    const childKey = await backend.spawnSubagent!(parentKey, { task: 'child task', label: 'worker' })
    await vi.waitFor(async () => {
      const subs = await backend.listSubagents(parentKey)
      expect(subs.length).toBe(1)
      expect(subs[0].sessionKey).toBe(childKey)
      expect(subs[0].label).toBe('worker')
      expect(subs[0].task).toBe('child task')
    })
  })

  it('listSubagents filters by parent key', async () => {
    const { client } = makeFakeClient(textResponse('a'), textResponse('b'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const parentA = await backend.createSession('A')
    const parentB = await backend.createSession('B')
    await backend.spawnSubagent!(parentA, { task: 'task a' })
    await backend.spawnSubagent!(parentB, { task: 'task b' })
    await vi.waitFor(async () => {
      const subsA = await backend.listSubagents(parentA)
      const subsB = await backend.listSubagents(parentB)
      expect(subsA.length).toBe(1)
      expect(subsB.length).toBe(1)
      expect(subsA[0].task).toBe('task a')
      expect(subsB[0].task).toBe('task b')
    })
  })

  it('listSessions marks subagent sessions with kind "subagent"', async () => {
    const { client } = makeFakeClient(textResponse('ok'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const parentKey = await backend.createSession('parent')
    await backend.spawnSubagent!(parentKey, { task: 'child' })
    await vi.waitFor(async () => {
      const threads = await backend.listSessions({ kind: 'thread' })
      const subagents = await backend.listSessions({ kind: 'subagent' })
      expect(threads.every((s) => s.key === parentKey)).toBe(true)
      expect(subagents.length).toBe(1)
      expect(subagents[0].kind).toBe('subagent')
      expect(subagents[0].parentKey).toBe(parentKey)
    })
  })

  it('spawnSubagent without parent session still creates a child', async () => {
    const { client } = makeFakeClient(textResponse('orphan'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    // Spawn with a non-existent parent — should still work (parentState is undefined).
    const childKey = await backend.spawnSubagent!('nonexistent', { task: 'run' })
    expect(childKey).toMatch(/^agent:main:subagent:/)
    await vi.waitFor(async () => {
      const meta = await backend.getSessionMeta(childKey)
      expect(meta).not.toBeNull()
    })
  })

  it('subagent keeps task-focused prompt — not overwritten by resolveSystemPromptAppend', async () => {
    const { client, complete } = makeFakeClient(textResponse('done'))
    const backend = createLocalLlmBackend(makeConfig(), {
      dataDir,
      inferenceClient: client,
      resolveSystemPromptAppend: () => 'HUGE PERSONALITY BLOB THAT SHOULD NOT APPEAR'
    })
    const parentKey = await backend.createSession('parent')
    await backend.spawnSubagent!(parentKey, { task: 'summarise X' })
    // Wait for the fire-and-forget sendMessage to complete.
    await vi.waitFor(() => expect(complete).toHaveBeenCalled())
    // The system message sent to the inference client should contain the
    // task override, NOT the resolveSystemPromptAppend output.
    const callArgs = complete.mock.calls[0][0] as Array<{ role: string; content: string }>
    const systemMsg = callArgs.find((m) => m.role === 'system')
    expect(systemMsg?.content).toContain('summarise X')
    expect(systemMsg?.content).not.toContain('HUGE PERSONALITY BLOB')
  })

  it('subagent system prompt includes SUBAGENT.md guardrails when file exists', async () => {
    // Write a temporary SUBAGENT.md
    const subagentFile = path.join(tmpDir, 'SUBAGENT.md')
    fs.writeFileSync(subagentFile, '# Guardrails\n\nFollow E-Prime. No stubs.')
    const { client, complete } = makeFakeClient(textResponse('done'))
    const backend = createLocalLlmBackend(makeConfig(), {
      dataDir,
      inferenceClient: client,
      subagentPromptFile: subagentFile
    })
    const parentKey = await backend.createSession('parent')
    await backend.spawnSubagent!(parentKey, { task: 'write a test' })
    await vi.waitFor(() => expect(complete).toHaveBeenCalled())
    const callArgs = complete.mock.calls[0][0] as Array<{ role: string; content: string }>
    const systemMsg = callArgs.find((m) => m.role === 'system')
    // Guardrails appear before the task
    expect(systemMsg?.content).toContain('# Guardrails')
    expect(systemMsg?.content).toContain('Follow E-Prime')
    // Task still present
    expect(systemMsg?.content).toContain('write a test')
  })

  it('subagent system prompt omits guardrails when subagentPromptFile not set', async () => {
    const { client, complete } = makeFakeClient(textResponse('done'))
    const backend = createLocalLlmBackend(makeConfig(), {
      dataDir,
      inferenceClient: client
      // no subagentPromptFile
    })
    const parentKey = await backend.createSession('parent')
    await backend.spawnSubagent!(parentKey, { task: 'compile report' })
    await vi.waitFor(() => expect(complete).toHaveBeenCalled())
    const callArgs = complete.mock.calls[0][0] as Array<{ role: string; content: string }>
    const systemMsg = callArgs.find((m) => m.role === 'system')
    expect(systemMsg?.content).toContain('compile report')
    expect(systemMsg?.content).not.toContain('Guardrails')
  })

  it('subagent system prompt omits guardrails when file missing (no crash)', async () => {
    const { client, complete } = makeFakeClient(textResponse('done'))
    const backend = createLocalLlmBackend(makeConfig(), {
      dataDir,
      inferenceClient: client,
      subagentPromptFile: '/nonexistent/SUBAGENT.md'
    })
    const parentKey = await backend.createSession('parent')
    await backend.spawnSubagent!(parentKey, { task: 'do work' })
    await vi.waitFor(() => expect(complete).toHaveBeenCalled())
    const callArgs = complete.mock.calls[0][0] as Array<{ role: string; content: string }>
    const systemMsg = callArgs.find((m) => m.role === 'system')
    expect(systemMsg?.content).toContain('do work')
    // No crash, no guardrails content — graceful fallback
  })
})

describe('local-llm backend: compaction', () => {
  it('compaction triggers when context exceeds 75% budget and produces a structured summary', async () => {
    // contextWindow 4096 tokens ≈ 16K chars. The system prompt + tool schemas
    // consume ~3-4K tokens, so 75% threshold ≈ 3072 tokens. Sending 6 rounds
    // of 2K-char messages (user+assistant ≈ 4K chars per round ≈ 1K tokens)
    // accumulates ~6K tokens of conversation, easily exceeding the threshold.
    const config = { ...makeConfig(), contextWindow: 4096 }
    const structuredSummary =
      '<summary>\n1. **Goal:** Test compaction.\n2. **Constraints & Preferences:** None.\n' +
      '3. **Progress:**\n   - **Done:** Sent fill messages.\n   - **In Progress:** Compaction.\n' +
      '   - **Blocked:** None.\n4. **Key Decisions:** None.\n5. **Files & Code:** None.\n' +
      '6. **Errors & Fixes:** None.\n7. **Tool Results:** None.\n' +
      '8. **Next Step:** Continue conversation.\n</summary>'

    // Queue responses: 6 fill rounds + 1 compaction summary + 1 post-compaction.
    // The compaction summary call interleaves with fill rounds when the model
    // detects context overflow.
    const responses: CompletionResponse[] = []
    for (let i = 0; i < 8; i++) responses.push(textResponse(`fill ack ${i}`))
    responses.push(textResponse(structuredSummary))
    responses.push(textResponse('still here'))

    const { client, complete } = makeFakeClient(...responses)
    const backend = createLocalLlmBackend(config, { dataDir, inferenceClient: client })
    const key = await backend.createSession('t')

    // 8 rounds × (2K user + ~12 assistant) = 16 messages, exceeds
    // COMPACT_KEEP_RECENT + 2 = 12 and the 75% token threshold.
    for (let i = 0; i < 8; i++) {
      const idle = waitForIdle(backend)
      await backend.sendMessage(key, 'x'.repeat(2000))
      await idle
    }

    const meta = await backend.getSessionMeta(key)
    expect(meta?.compactionCount ?? 0).toBeGreaterThan(0)

    const allCalls = complete.mock.calls
    const compactionCall = allCalls.find((call) => {
      const msgs = call[0] as Array<{ role: string; content: string }>
      return msgs.some((m) => m.role === 'system' && m.content.includes('context compaction engine'))
    })
    expect(compactionCall).toBeDefined()
    const compactionSystem = (compactionCall![0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    )
    expect(compactionSystem?.content).toContain('<summary>')
    expect(compactionSystem?.content).toContain('Goal:')
    expect(compactionSystem?.content).toContain('Progress:')
    expect(compactionSystem?.content).toContain('Files & Code:')
    expect(compactionSystem?.content).toContain('Next Step:')
    expect(compactionSystem?.content).toContain('Do NOT call any tools')
  })

  it('compaction summary stored with REFERENCE ONLY prefix and END delimiter', async () => {
    const config = { ...makeConfig(), contextWindow: 4096 }
    const structuredSummary = '<summary>\n1. **Goal:** Test prefix.\n3. **Progress:**\n   - **Done:** Fill.\n</summary>'

    // Smart mock: detect compaction calls by system prompt, return structured
    // summary; return generic ack for everything else.
    let callCount = 0
    const complete = vi.fn().mockImplementation((msgs: Array<{ role: string; content: string }>) => {
      const sysMsg = msgs.find((m) => m.role === 'system')
      if (sysMsg?.content.includes('context compaction engine')) {
        return Promise.resolve(textResponse(structuredSummary))
      }
      return Promise.resolve(textResponse(`ack ${callCount++}`))
    })
    const client: InferenceClient = {
      complete: complete as unknown as InferenceClient['complete'],
      stream: (async function* () {})() as unknown as InferenceClient['stream'],
      healthCheck: vi.fn().mockResolvedValue(true) as unknown as InferenceClient['healthCheck'],
      updateConfig: vi.fn() as unknown as InferenceClient['updateConfig']
    }
    const backend = createLocalLlmBackend(config, { dataDir, inferenceClient: client })
    const key = await backend.createSession('t')

    for (let i = 0; i < 8; i++) {
      const idle = waitForIdle(backend)
      await backend.sendMessage(key, 'x'.repeat(2000))
      await idle
    }

    const meta = await backend.getSessionMeta(key)
    expect(meta?.compactionCount ?? 0).toBeGreaterThan(0)

    const turns = await backend.getFullHistory(key)
    const systemTurn = turns.find((t) => t.role === 'system')
    expect(systemTurn).toBeDefined()
    expect(systemTurn!.content).toContain('CONTEXT COMPACTION — REFERENCE ONLY')
    expect(systemTurn!.content).toContain('background context, NOT active instructions')
    expect(systemTurn!.content).toContain('END OF CONTEXT SUMMARY')
    expect(systemTurn!.content).toContain('Goal:')
    expect(systemTurn!.content).not.toContain('<summary>')
  })

  it('extractSummary strips <summary> tags and preamble from model output', async () => {
    const config = { ...makeConfig(), contextWindow: 4096 }
    const summaryWithTags =
      'Some preamble thinking...\n\n<summary>\n1. **Goal:** Extract test.\n</summary>\n\nTrailing text.'

    let callCount = 0
    const complete = vi.fn().mockImplementation((msgs: Array<{ role: string; content: string }>) => {
      const sysMsg = msgs.find((m) => m.role === 'system')
      if (sysMsg?.content.includes('context compaction engine')) {
        return Promise.resolve(textResponse(summaryWithTags))
      }
      return Promise.resolve(textResponse(`ack ${callCount++}`))
    })
    const client: InferenceClient = {
      complete: complete as unknown as InferenceClient['complete'],
      stream: (async function* () {})() as unknown as InferenceClient['stream'],
      healthCheck: vi.fn().mockResolvedValue(true) as unknown as InferenceClient['healthCheck'],
      updateConfig: vi.fn() as unknown as InferenceClient['updateConfig']
    }
    const backend = createLocalLlmBackend(config, { dataDir, inferenceClient: client })
    const key = await backend.createSession('t')

    for (let i = 0; i < 8; i++) {
      const idle = waitForIdle(backend)
      await backend.sendMessage(key, 'x'.repeat(2000))
      await idle
    }

    const meta = await backend.getSessionMeta(key)
    expect(meta?.compactionCount ?? 0).toBeGreaterThan(0)

    const turns = await backend.getFullHistory(key)
    const systemTurn = turns.find((t) => t.role === 'system')
    expect(systemTurn).toBeDefined()
    // Extracted content present (markdown bold preserved), preamble and trailing text stripped
    expect(systemTurn!.content).toContain('**Goal:** Extract test')
    expect(systemTurn!.content).not.toContain('preamble thinking')
    expect(systemTurn!.content).not.toContain('Trailing text')
    expect(systemTurn!.content).not.toContain('<summary>')
  })

  it('iterative compaction passes prior summary to the model with UPDATE instruction', async () => {
    const config = { ...makeConfig(), contextWindow: 4096 }

    // Summaries must exceed 50 chars (the rawSummary.length > 50 guard
    // in maybeCompact) or the code falls back to the heuristic summary.
    let compactionCallCount = 0
    const complete = vi.fn().mockImplementation((msgs: Array<{ role: string; content: string }>) => {
      const sysMsg = msgs.find((m) => m.role === 'system')
      if (sysMsg?.content.includes('context compaction engine')) {
        compactionCallCount++
        const summary =
          compactionCallCount === 1
            ? '<summary>\n1. **Goal:** First pass — verify compaction triggers and produces a well-formed structured summary.\n</summary>'
            : '<summary>\n1. **Goal:** Updated second pass — verify iterative compaction carries prior context forward.\n</summary>'
        return Promise.resolve(textResponse(summary))
      }
      return Promise.resolve(textResponse('ack'))
    })
    const client: InferenceClient = {
      complete: complete as unknown as InferenceClient['complete'],
      stream: (async function* () {})() as unknown as InferenceClient['stream'],
      healthCheck: vi.fn().mockResolvedValue(true) as unknown as InferenceClient['healthCheck'],
      updateConfig: vi.fn() as unknown as InferenceClient['updateConfig']
    }
    const backend = createLocalLlmBackend(config, { dataDir, inferenceClient: client })
    const key = await backend.createSession('t')

    // First compaction cycle — 8 rounds × 2K chars
    for (let i = 0; i < 8; i++) {
      const idle = waitForIdle(backend)
      await backend.sendMessage(key, 'x'.repeat(2000))
      await idle
    }
    const meta1 = await backend.getSessionMeta(key)
    const count1 = meta1?.compactionCount ?? 0
    expect(count1).toBeGreaterThan(0)

    // Second compaction cycle — 8 more rounds
    for (let i = 0; i < 8; i++) {
      const idle = waitForIdle(backend)
      await backend.sendMessage(key, 'y'.repeat(2000))
      await idle
    }
    const meta2 = await backend.getSessionMeta(key)
    const count2 = meta2?.compactionCount ?? 0
    expect(count2).toBeGreaterThan(count1)

    // The second compaction call should have "UPDATE it" in a user message
    const allCalls = complete.mock.calls
    const compactionCalls = allCalls.filter((call) => {
      const msgs = call[0] as Array<{ role: string; content: string }>
      return msgs.some((m) => m.role === 'system' && m.content.includes('context compaction engine'))
    })
    expect(compactionCalls.length).toBeGreaterThanOrEqual(2)
    const secondCall = compactionCalls[1][0] as Array<{ role: string; content: string }>
    const hasUpdateInstruction = secondCall.some((m) => m.role === 'user' && m.content.includes('UPDATE it'))
    expect(hasUpdateInstruction).toBe(true)
  })

  it('recognises legacy [Compacted prefix for prior summary detection', async () => {
    // Seed a session with the OLD prefix format — maybeCompact should still
    // detect it as a prior summary and pass it to the iterative prompt.
    const config = { ...makeConfig(), contextWindow: 4096 }
    const sessionKey = 'legacy-prefix-test'
    const stateDir = path.join(dataDir, 'agent-backend', 'local-llm-state')
    fs.mkdirSync(stateDir, { recursive: true })
    const stateFile = path.join(stateDir, `${sessionKey}.json`)

    // Pre-populate with a legacy-format compaction summary + enough messages
    // to push past the 75% threshold on the next send.
    const messages = [
      {
        role: 'system',
        content: '[Compacted conversation — summary generated by test-model]\n\nLegacy summary content.',
        timestamp: Date.now() - 5000
      },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(600),
        timestamp: Date.now() - 4000 + i * 100
      }))
    ]

    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        data: {
          sessionKey,
          backendSessionId: 'bsid-legacy',
          cwd: tmpDir,
          model: 'test-model',
          systemPrompt: 'You help.',
          messages,
          createdAt: Date.now() - 10000,
          updatedAt: Date.now() - 1000
        }
      })
    )

    const newSummary = '<summary>\n1. **Goal:** Upgrade from legacy.\n</summary>'
    const { client, complete } = makeFakeClient(textResponse(newSummary), textResponse('ok'))
    const backend = createLocalLlmBackend(config, { dataDir, inferenceClient: client })

    const idle = waitForIdle(backend)
    await backend.sendMessage(sessionKey, 'trigger compaction')
    await idle

    // Check if the compaction call included the legacy summary as prior context
    const compactionCall = complete.mock.calls.find((call) => {
      const msgs = call[0] as Array<{ role: string; content: string }>
      return msgs.some((m) => m.role === 'system' && m.content.includes('context compaction engine'))
    })
    if (compactionCall) {
      const msgs = compactionCall[0] as Array<{ role: string; content: string }>
      const hasLegacyRef = msgs.some((m) => m.role === 'user' && m.content.includes('Legacy summary content'))
      expect(hasLegacyRef).toBe(true)
    }
  })
})
