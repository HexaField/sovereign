import { describe, it, expect, vi } from 'vitest'
import { runToolLoop, type ChatMessage, type ToolLoopDeps } from './tool-loop.js'
import { ContextOverflowError, type CompletionResponse } from './inference.js'

function response(
  message: { content: string | null; tool_calls?: CompletionResponse['choices'][number]['message']['tool_calls'] },
  finishReason: 'stop' | 'tool_calls' | 'length' = message.tool_calls?.length ? 'tool_calls' : 'stop'
): CompletionResponse {
  return {
    id: 'resp',
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }]
  }
}

function baseDeps(overrides: Partial<ToolLoopDeps> = {}): ToolLoopDeps {
  return {
    complete: vi.fn(),
    executeTool: vi.fn(),
    emit: vi.fn(),
    toolSchemas: [],
    ...overrides
  }
}

function userMsg(text: string): ChatMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

describe('runToolLoop', () => {
  it('terminates in one round when the model returns no tool calls', async () => {
    const complete = vi.fn().mockResolvedValue(response({ content: 'Hello there.' }))
    const deps = baseDeps({ complete })
    const messages = [userMsg('hi')]

    const result = await runToolLoop('sess', messages, deps)

    expect(complete).toHaveBeenCalledTimes(1)
    expect(result.finalContent).toBe('Hello there.')
    expect(result.toolCallCount).toBe(0)
    expect(messages).toHaveLength(2) // user + assistant
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Hello there.' })
  })

  it('executes a tool call, feeds the result back, and completes on the second round', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/tmp/x"}' } }
          ]
        })
      )
      .mockResolvedValueOnce(response({ content: 'The file says hi.' }))
    const executeTool = vi.fn().mockResolvedValue({ content: 'file contents' })
    const emit = vi.fn()
    const deps = baseDeps({ complete, executeTool, emit })
    const messages = [userMsg('read /tmp/x')]

    const result = await runToolLoop('sess', messages, deps)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(executeTool).toHaveBeenCalledWith('Read', { file_path: '/tmp/x' })
    expect(result.toolCallCount).toBe(1)
    expect(result.finalContent).toBe('The file says hi.')

    // messages: user, assistant(tool_calls), tool(result), assistant(final)
    expect(messages).toHaveLength(4)
    expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'file contents' })

    const emittedTypes = emit.mock.calls.map((c) => [c[0], (c[1] as { work?: { type?: string } }).work?.type])
    expect(emittedTypes).toContainEqual(['chat.work', 'tool_call'])
    expect(emittedTypes).toContainEqual(['chat.work', 'tool_result'])
    expect(emittedTypes).toContainEqual(['chat.stream', undefined])
  })

  it('executes a tool call even when finish_reason says "stop" (lenient cross-server handling)', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'LS', arguments: '{}' } }]
          },
          'stop' // several llama.cpp/ollama builds mis-set this even when tool_calls is present
        )
      )
      .mockResolvedValueOnce(response({ content: 'done' }))
    const executeTool = vi.fn().mockResolvedValue({ content: 'listing' })
    const deps = baseDeps({ complete, executeTool })

    const result = await runToolLoop('sess', [userMsg('ls')], deps)

    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(result.toolCallCount).toBe(1)
  })

  it('surfaces malformed tool-call JSON as a tool error instead of throwing', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{not valid json' } }]
        })
      )
      .mockResolvedValueOnce(response({ content: 'recovered' }))
    const executeTool = vi.fn()
    const deps = baseDeps({ complete, executeTool })
    const messages = [userMsg('hi')]

    const result = await runToolLoop('sess', messages, deps)

    expect(executeTool).not.toHaveBeenCalled()
    expect(result.toolCallCount).toBe(1)
    const toolMsg = messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toMatch(/Failed to parse tool arguments/)
  })

  it('assigns a fallback id when the server omits tool_call.id', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          content: null,
          tool_calls: [{ id: '', type: 'function', function: { name: 'LS', arguments: '{}' } }]
        })
      )
      .mockResolvedValueOnce(response({ content: 'done' }))
    const executeTool = vi.fn().mockResolvedValue({ content: 'ok' })
    const messages = [userMsg('hi')]

    await runToolLoop('sess', messages, baseDeps({ complete, executeTool }))

    const assistantWithCall = messages.find((m) => m.role === 'assistant' && m.tool_calls?.length)
    const toolResult = messages.find((m) => m.role === 'tool')
    expect(assistantWithCall?.tool_calls?.[0].id).toBeTruthy()
    expect(toolResult?.tool_call_id).toBe(assistantWithCall?.tool_calls?.[0].id)
  })

  it('stops after maxIterations and emits a chat.error', async () => {
    const complete = vi.fn().mockResolvedValue(
      response({
        content: null,
        tool_calls: [{ id: 'loop', type: 'function', function: { name: 'LS', arguments: '{}' } }]
      })
    )
    const executeTool = vi.fn().mockResolvedValue({ content: 'ok' })
    const emit = vi.fn()
    const deps = baseDeps({ complete, executeTool, emit, maxIterations: 3 })

    await runToolLoop('sess', [userMsg('loop forever')], deps)

    expect(complete).toHaveBeenCalledTimes(3)
    const errorCalls = emit.mock.calls.filter((c) => c[0] === 'chat.error')
    expect(errorCalls).toHaveLength(1)
    expect((errorCalls[0][1] as { error: string }).error).toMatch(/maximum of 3 iterations/)
  })

  it('throws AbortError immediately when the signal is already aborted', async () => {
    const complete = vi.fn()
    const controller = new AbortController()
    controller.abort()

    await expect(runToolLoop('sess', [userMsg('hi')], baseDeps({ complete }), controller.signal)).rejects.toMatchObject(
      {
        name: 'AbortError'
      }
    )
    expect(complete).not.toHaveBeenCalled()
  })

  it('does not emit chat.stream for an empty/null content round', async () => {
    const complete = vi.fn().mockResolvedValue(response({ content: null }))
    const emit = vi.fn()
    await runToolLoop('sess', [userMsg('hi')], baseDeps({ complete, emit }))
    expect(emit.mock.calls.some((c) => c[0] === 'chat.stream')).toBe(false)
  })

  it('catches ContextOverflowError, calls onContextOverflow, and retries', async () => {
    // First call: overflow. After compaction: success.
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new ContextOverflowError(400, 'exceeds the available context size'))
      .mockResolvedValueOnce(response({ content: 'Done after compaction.' }))
    const onContextOverflow = vi.fn().mockResolvedValue(true)
    const emit = vi.fn()
    const deps = baseDeps({ complete, emit, onContextOverflow })
    const messages = [userMsg('do something big')]

    const result = await runToolLoop('sess', messages, deps)

    expect(onContextOverflow).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(2) // overflow + retry
    expect(result.finalContent).toBe('Done after compaction.')
  })

  it('re-throws ContextOverflowError when onContextOverflow returns false', async () => {
    const complete = vi.fn().mockRejectedValue(new ContextOverflowError(400, 'exceeds the available context size'))
    const onContextOverflow = vi.fn().mockResolvedValue(false)
    const deps = baseDeps({ complete, onContextOverflow })

    await expect(runToolLoop('sess', [userMsg('overflow')], deps)).rejects.toThrow(ContextOverflowError)
    expect(onContextOverflow).toHaveBeenCalledTimes(1)
  })

  it('re-throws ContextOverflowError when no onContextOverflow handler exists', async () => {
    const complete = vi.fn().mockRejectedValue(new ContextOverflowError(400, 'exceeds the available context size'))
    const deps = baseDeps({ complete })

    await expect(runToolLoop('sess', [userMsg('overflow')], deps)).rejects.toThrow(ContextOverflowError)
  })
})
