// Tests for makePresenceAwareAppendResolver — verifies PRESENCE.md,
// PRESENCE_MEMORY.md, and PRESENCE_KNOWLEDGE.md are appended to the correct
// presence-thread sessions (internal gets all three; gateway gets knowledge
// only; normal threads get nothing).

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ThreadManager } from '@sovereign/threads'
import { makePresenceAwareAppendResolver } from './wiring.js'

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'presence-resolver-'))
}

const PRESENCE_ID = '11111111-1111-1111-1111-111111111111'
const GATEWAY_ID = '33333333-3333-3333-3333-333333333333'
const NORMAL_ID = '22222222-2222-2222-2222-222222222222'

function makeThreadManager(): ThreadManager {
  return {
    get(id: string) {
      if (id === PRESENCE_ID) return { id: PRESENCE_ID, label: 'presence-internal', presence: 'internal' } as any
      if (id === GATEWAY_ID) return { id: GATEWAY_ID, label: 'presence', presence: 'gateway' } as any
      if (id === NORMAL_ID) return { id: NORMAL_ID, label: 'normal' } as any
      return undefined
    }
  } as unknown as ThreadManager
}

describe('makePresenceAwareAppendResolver', () => {
  let dir: string
  beforeEach(() => {
    dir = mkTmp()
  })

  it('appends presence personality + memory + knowledge for the internal session', () => {
    const personalityFile = path.join(dir, 'PRESENCE.md')
    const memoryFile = path.join(dir, 'PRESENCE_MEMORY.md')
    const knowledgeFile = path.join(dir, 'PRESENCE_KNOWLEDGE.md')
    fs.writeFileSync(personalityFile, '## presence personality')
    fs.writeFileSync(memoryFile, '## presence memory')
    fs.writeFileSync(knowledgeFile, '## knowledge graph')
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => PRESENCE_ID,
      gatewayThreadId: () => GATEWAY_ID,
      personalityFile,
      memoryFile,
      knowledgeFile
    })
    const presenceText = resolver?.(PRESENCE_ID)
    expect(presenceText).toContain('presence personality')
    expect(presenceText).toContain('presence memory')
    expect(presenceText).toContain('knowledge graph')
  })

  it('appends ONLY knowledge for the gateway session', () => {
    const personalityFile = path.join(dir, 'PRESENCE.md')
    const memoryFile = path.join(dir, 'PRESENCE_MEMORY.md')
    const knowledgeFile = path.join(dir, 'PRESENCE_KNOWLEDGE.md')
    fs.writeFileSync(personalityFile, '## presence personality')
    fs.writeFileSync(memoryFile, '## presence memory')
    fs.writeFileSync(knowledgeFile, '## knowledge graph')
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => PRESENCE_ID,
      gatewayThreadId: () => GATEWAY_ID,
      personalityFile,
      memoryFile,
      knowledgeFile
    })
    const gatewayText = resolver?.(GATEWAY_ID)
    expect(gatewayText).toContain('knowledge graph')
    expect(gatewayText).not.toContain('presence personality')
    expect(gatewayText).not.toContain('presence memory')
  })

  it('returns undefined for a normal thread', () => {
    const personalityFile = path.join(dir, 'PRESENCE.md')
    const knowledgeFile = path.join(dir, 'PRESENCE_KNOWLEDGE.md')
    fs.writeFileSync(personalityFile, '## presence personality')
    fs.writeFileSync(knowledgeFile, '## knowledge graph')
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => PRESENCE_ID,
      gatewayThreadId: () => GATEWAY_ID,
      personalityFile,
      knowledgeFile
    })
    expect(resolver?.(NORMAL_ID)).toBeUndefined()
  })

  it('handles missing presence files silently (no throw)', () => {
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => PRESENCE_ID,
      gatewayThreadId: () => GATEWAY_ID,
      personalityFile: path.join(dir, 'missing.md'),
      memoryFile: path.join(dir, 'missing2.md'),
      knowledgeFile: path.join(dir, 'missing3.md')
    })
    expect(() => resolver?.(PRESENCE_ID)).not.toThrow()
    expect(resolver?.(PRESENCE_ID)).toBeUndefined()
  })

  it('does NOT append presence files when internalThreadId returns null', () => {
    const personalityFile = path.join(dir, 'PRESENCE.md')
    const knowledgeFile = path.join(dir, 'PRESENCE_KNOWLEDGE.md')
    fs.writeFileSync(personalityFile, 'X')
    fs.writeFileSync(knowledgeFile, 'Y')
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => null,
      gatewayThreadId: () => null,
      personalityFile,
      knowledgeFile
    })
    expect(resolver?.(PRESENCE_ID)).toBeUndefined()
  })

  it('appends knowledge to gateway even when internal files are absent', () => {
    const knowledgeFile = path.join(dir, 'PRESENCE_KNOWLEDGE.md')
    fs.writeFileSync(knowledgeFile, '## knowledge graph')
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => PRESENCE_ID,
      gatewayThreadId: () => GATEWAY_ID,
      knowledgeFile
    })
    const gatewayText = resolver?.(GATEWAY_ID)
    expect(gatewayText).toContain('knowledge graph')
  })

  it('injects health summary into the internal thread when provided', () => {
    const personalityFile = path.join(dir, 'PRESENCE.md')
    fs.writeFileSync(personalityFile, '## presence personality')
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => PRESENCE_ID,
      gatewayThreadId: () => GATEWAY_ID,
      personalityFile,
      getHealthSummary: () => '# Service health\n\n- ✓ AD4M: ok'
    })
    const text = resolver?.(PRESENCE_ID)
    expect(text).toContain('Service health')
    expect(text).toContain('AD4M: ok')
  })

  it('does NOT inject health summary into the gateway thread', () => {
    const knowledgeFile = path.join(dir, 'PRESENCE_KNOWLEDGE.md')
    fs.writeFileSync(knowledgeFile, '## knowledge graph')
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => PRESENCE_ID,
      gatewayThreadId: () => GATEWAY_ID,
      knowledgeFile,
      getHealthSummary: () => '# Service health\n\n- ✓ AD4M: ok'
    })
    const text = resolver?.(GATEWAY_ID)
    expect(text).toContain('knowledge graph')
    expect(text).not.toContain('Service health')
  })

  it('handles getHealthSummary returning undefined', () => {
    const personalityFile = path.join(dir, 'PRESENCE.md')
    fs.writeFileSync(personalityFile, '## presence personality')
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => PRESENCE_ID,
      gatewayThreadId: () => GATEWAY_ID,
      personalityFile,
      getHealthSummary: () => undefined
    })
    const text = resolver?.(PRESENCE_ID)
    expect(text).toContain('presence personality')
    expect(text).not.toContain('Service health')
  })
})
