// Membrane → session context injection resolver tests.
//
// `makeMembraneAppendResolver` is the bridge between the membrane layer
// and the Claude Code adapter — given a session key, it resolves the
// thread, looks up its membrane, and returns the rendered CONTEXT.md
// body to be appended to the SDK's preset system prompt.

import { describe, it, expect } from 'vitest'
import type { MembraneManager } from '@sovereign/membranes'
import type { ThreadManager } from '@sovereign/threads'
import { makeMembraneAppendResolver } from './wiring.js'

function stubThreads(map: Record<string, { membraneId?: string }>): ThreadManager {
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
