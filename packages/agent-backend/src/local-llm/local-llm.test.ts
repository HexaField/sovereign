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
    toolCallFormat: 'auto',
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

  it('capabilities() reports an honest, non-subagent-capable local backend', () => {
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: makeFakeClient().client })
    const caps = backend.capabilities()
    expect(caps.subagents).toBe('unsupported')
    expect(caps.multiProvider).toBe(true)
    expect(caps.toolStreaming).toBe(true)
  })

  it('listSubagents always returns empty (no native subagent support)', async () => {
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

describe('local-llm backend: sendMessage (no tools)', () => {
  it('runs one completion round and emits a matching chat.turn + status transitions', async () => {
    const { client, complete } = makeFakeClient(textResponse('General Kenobi.'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const { turns, statuses } = collectEvents(backend)

    const key = await backend.createSession('t')
    await backend.sendMessage(key, 'Hello there.')

    expect(complete).toHaveBeenCalledTimes(1)
    expect(turns).toHaveLength(1)
    expect(turns[0].content).toBe('General Kenobi.')
    expect(statuses).toEqual(['working', 'idle'])
  })

  it('getFullHistory reconstructs user + assistant turns from the persisted transcript', async () => {
    const { client } = makeFakeClient(textResponse('answer'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const key = await backend.createSession('t')
    await backend.sendMessage(key, 'question')

    const turns = await backend.getFullHistory(key)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(turns[0].content).toBe('question')
    expect(turns[1].content).toBe('answer')
  })

  it('lazily creates a session on sendMessage if none was created first', async () => {
    const { client } = makeFakeClient(textResponse('ok'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    await backend.sendMessage('never-created', 'hi')
    const turns = await backend.getFullHistory('never-created')
    expect(turns).toHaveLength(2)
  })

  it('queues a second sendMessage sent before the first resolves instead of dropping it', async () => {
    const { client, complete } = makeFakeClient(textResponse('first answer'), textResponse('second answer'))
    const backend = createLocalLlmBackend(makeConfig(), { dataDir, inferenceClient: client })
    const { turns } = collectEvents(backend)
    const key = await backend.createSession('t')

    const p1 = backend.sendMessage(key, 'first question')
    const p2 = backend.sendMessage(key, 'second question')
    await Promise.all([p1, p2])

    expect(complete).toHaveBeenCalledTimes(2)
    expect(turns.map((t) => t.content)).toEqual(['first answer', 'second answer'])
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

    await backend.sendMessage(key, 'write a file')

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

    await backend.sendMessage(key, 'list files')

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

    const sendPromise = backend.sendMessage(key, 'hi')
    await new Promise((r) => setTimeout(r, 20)) // let runTurn reach the pending complete() call
    await backend.abort(key)
    await sendPromise

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

    await backend.sendMessage(key, 'hi')

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
    await backend.sendMessage(key, 'hi')
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
    await backendA.sendMessage(key, 'question')
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
    expect(budget?.tools?.entries.length).toBe(7)
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

    await backend.sendMessage(key, 'read the big file') // user, assistant(tool_call), tool(result), assistant(final)
    for (let i = 0; i < 12; i++) {
      await backend.sendMessage(key, `filler question ${i}`) // user, assistant
    }

    const result = await backend.recycleSession?.(key, { force: true })
    expect(result).not.toBeNull()
    expect(result?.reclaimedBytes ?? 0).toBeGreaterThan(0)
    expect(result?.postTokens ?? Infinity).toBeLessThan(result?.preTokens ?? 0)

    const turns = await backend.getFullHistory(key)
    expect(JSON.stringify(turns)).toContain('pruned')
  })
})
