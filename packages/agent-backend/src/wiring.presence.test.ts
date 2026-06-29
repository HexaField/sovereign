// Tests for makePresenceAwareAppendResolver — verifies PRESENCE.md and
// PRESENCE_MEMORY.md are appended only for the presence-thread session.

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
const NORMAL_ID = '22222222-2222-2222-2222-222222222222'

function makeThreadManager(): ThreadManager {
  return {
    get(id: string) {
      if (id === PRESENCE_ID) return { id: PRESENCE_ID, label: 'presence-internal', presence: 'internal' } as any
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

  it('appends presence personality + memory only for the presence session', () => {
    const personalityFile = path.join(dir, 'PRESENCE.md')
    const memoryFile = path.join(dir, 'PRESENCE_MEMORY.md')
    fs.writeFileSync(personalityFile, '## presence personality')
    fs.writeFileSync(memoryFile, '## presence memory')
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => PRESENCE_ID,
      personalityFile,
      memoryFile
    })
    const presenceText = resolver?.(PRESENCE_ID)
    expect(presenceText).toContain('presence personality')
    expect(presenceText).toContain('presence memory')
    expect(resolver?.(NORMAL_ID)).toBeUndefined()
  })

  it('returns undefined when files are missing and thread is not presence', () => {
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => PRESENCE_ID,
      personalityFile: path.join(dir, 'nope.md'),
      memoryFile: path.join(dir, 'nope2.md')
    })
    expect(resolver?.(NORMAL_ID)).toBeUndefined()
  })

  it('handles missing presence files silently (no throw)', () => {
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => PRESENCE_ID,
      personalityFile: path.join(dir, 'missing.md'),
      memoryFile: path.join(dir, 'missing2.md')
    })
    expect(() => resolver?.(PRESENCE_ID)).not.toThrow()
    expect(resolver?.(PRESENCE_ID)).toBeUndefined()
  })

  it('does NOT append presence files when internalThreadId returns null', () => {
    const personalityFile = path.join(dir, 'PRESENCE.md')
    fs.writeFileSync(personalityFile, 'X')
    const resolver = makePresenceAwareAppendResolver(undefined, makeThreadManager(), {
      internalThreadId: () => null,
      personalityFile
    })
    expect(resolver?.(PRESENCE_ID)).toBeUndefined()
  })
})
