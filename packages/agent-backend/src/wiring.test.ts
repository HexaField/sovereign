// Membrane → session context injection resolver tests.
//
// `makeMembraneAppendResolver` is the bridge between the membrane layer
// and the Claude Code adapter — given a session key, it resolves the
// thread, looks up its membrane, and returns the rendered CONTEXT.md
// body to be appended to the SDK's preset system prompt.

import { describe, it, expect } from 'vitest'
import type { MembraneManager } from '@sovereign/membranes'
import type { ThreadManager } from '@sovereign/threads'
import { makeMembraneAppendResolver, makePresenceAwareAppendResolver, makeSubagentToolBlocker } from './wiring.js'

function stubThreads(
  map: Record<string, { membraneId?: string; subagentBackend?: string; subagentModel?: string }>
): ThreadManager {
  return {
    get(key: string) {
      return map[key] as any
    }
  } as unknown as ThreadManager
}

function stubMembranes(contextByMembraneId: Record<string, string | null>): MembraneManager {
  return {
    renderContext(id: string) {
      return Object.prototype.hasOwnProperty.call(contextByMembraneId, id) ? contextByMembraneId[id] : null
    }
  } as unknown as MembraneManager
}

describe('makeMembraneAppendResolver', () => {
  it('returns undefined when membraneManager is missing', () => {
    const resolver = makeMembraneAppendResolver(undefined, stubThreads({}))
    expect(resolver).toBeUndefined()
  })

  it('returns undefined when threadManager is missing', () => {
    const resolver = makeMembraneAppendResolver(stubMembranes({}), undefined)
    expect(resolver).toBeUndefined()
  })

  it('maps agent:main:main → thread "main"', () => {
    const resolver = makeMembraneAppendResolver(
      stubMembranes({ personal: '# Personal context' }),
      stubThreads({ main: { membraneId: 'personal' } })
    )!
    expect(resolver('agent:main:main')).toBe('# Personal context')
  })

  it('maps agent:main:thread:<key> → thread "<key>"', () => {
    const resolver = makeMembraneAppendResolver(
      stubMembranes({ adam: 'AD4M context' }),
      stubThreads({ sovereign: { membraneId: 'adam' } })
    )!
    expect(resolver('agent:main:thread:sovereign')).toBe('AD4M context')
  })

  it('returns undefined for subagent / cron / unknown session keys', () => {
    const resolver = makeMembraneAppendResolver(
      stubMembranes({ personal: 'ctx' }),
      stubThreads({ main: { membraneId: 'personal' } })
    )!
    expect(resolver('agent:main:subagent:abc')).toBeUndefined()
    expect(resolver('agent:main:cron:xyz')).toBeUndefined()
    expect(resolver('')).toBeUndefined()
  })

  it('returns undefined when the thread is unknown', () => {
    const resolver = makeMembraneAppendResolver(
      stubMembranes({ personal: 'ctx' }),
      stubThreads({}) // no threads at all
    )!
    expect(resolver('agent:main:thread:ghost')).toBeUndefined()
  })

  it('returns undefined when the thread has no membraneId', () => {
    const resolver = makeMembraneAppendResolver(
      stubMembranes({ personal: 'ctx' }),
      stubThreads({ orphan: { membraneId: undefined } })
    )!
    expect(resolver('agent:main:thread:orphan')).toBeUndefined()
  })

  it('returns undefined when the membrane has no CONTEXT.md', () => {
    const resolver = makeMembraneAppendResolver(
      stubMembranes({ personal: null }),
      stubThreads({ main: { membraneId: 'personal' } })
    )!
    expect(resolver('agent:main:main')).toBeUndefined()
  })
})

describe('makePresenceAwareAppendResolver — subagent routing injection', () => {
  const noPresence = {
    internalThreadId: () => null,
    gatewayThreadId: () => null
  }

  it('injects subagent routing when thread has subagentBackend', () => {
    const resolver = makePresenceAwareAppendResolver(
      stubMembranes({}),
      stubThreads({ 'thread-1': { subagentBackend: 'local-llm' } }),
      noPresence
    )!
    const result = resolver('agent:main:thread:thread-1')
    expect(result).toContain('Subagent Routing')
    expect(result).toContain('local-llm')
  })

  it('injects subagent routing when thread has subagentModel', () => {
    const resolver = makePresenceAwareAppendResolver(
      stubMembranes({}),
      stubThreads({ 'thread-2': { subagentModel: 'qwen3.6-35b-a3b' } }),
      noPresence
    )!
    const result = resolver('agent:main:thread:thread-2')
    expect(result).toContain('Subagent Routing')
    expect(result).toContain('qwen3.6-35b-a3b')
  })

  it('injects both backend and model when both configured', () => {
    const resolver = makePresenceAwareAppendResolver(
      stubMembranes({}),
      stubThreads({ 'thread-3': { subagentBackend: 'local-llm', subagentModel: 'gemma-4-26b-a4b' } }),
      noPresence
    )!
    const result = resolver('agent:main:thread:thread-3')
    expect(result).toContain('local-llm')
    expect(result).toContain('gemma-4-26b-a4b')
  })

  it('does NOT inject subagent routing when thread has no subagent config', () => {
    const resolver = makePresenceAwareAppendResolver(stubMembranes({}), stubThreads({ 'thread-4': {} }), noPresence)!
    const result = resolver('agent:main:thread:thread-4')
    expect(result).toBeUndefined()
  })

  it('combines membrane context with subagent routing', () => {
    const resolver = makePresenceAwareAppendResolver(
      stubMembranes({ personal: '# Personal context' }),
      stubThreads({ 'thread-5': { membraneId: 'personal', subagentBackend: 'local-llm' } }),
      noPresence
    )!
    const result = resolver('agent:main:thread:thread-5')
    expect(result).toContain('# Personal context')
    expect(result).toContain('Subagent Routing')
    expect(result).toContain('local-llm')
  })

  it('does not inject subagent routing for subagent session keys', () => {
    const resolver = makePresenceAwareAppendResolver(
      stubMembranes({}),
      stubThreads({ 'thread-6': { subagentBackend: 'local-llm' } }),
      noPresence
    )!
    // Subagent sessions have key format agent:main:subagent:xxx — sessionKeyToThreadKey returns undefined
    const result = resolver('agent:main:subagent:some-child')
    expect(result).toBeUndefined()
  })
})

describe('makeSubagentToolBlocker', () => {
  it('blocks Agent/Workflow/SendMessage when subagentBackend targets a non-claude-code backend', () => {
    const blocker = makeSubagentToolBlocker(stubThreads({ 'thread-a': { subagentBackend: 'local-llm' } }))!
    const result = blocker('thread-a')
    expect(result).toEqual(['Agent', 'Workflow', 'SendMessage'])
  })

  it('returns undefined when subagentBackend targets claude-code (native subagents allowed)', () => {
    const blocker = makeSubagentToolBlocker(stubThreads({ 'thread-b': { subagentBackend: 'claude-code' } }))!
    expect(blocker('thread-b')).toBeUndefined()
  })

  it('returns undefined when thread has no subagent routing configured', () => {
    const blocker = makeSubagentToolBlocker(stubThreads({ 'thread-c': {} }))!
    expect(blocker('thread-c')).toBeUndefined()
  })

  it('returns undefined for subagent session keys (no thread match)', () => {
    const blocker = makeSubagentToolBlocker(stubThreads({ 'thread-d': { subagentBackend: 'local-llm' } }))!
    expect(blocker('agent:main:subagent:child-1')).toBeUndefined()
  })

  it('returns undefined when threadManager not provided', () => {
    const blocker = makeSubagentToolBlocker(undefined)
    expect(blocker).toBeUndefined()
  })
})
