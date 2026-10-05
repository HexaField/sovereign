import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  voiceDraftFor,
  voiceDraftActions,
  publishVoiceDraft,
  clearVoiceDraft,
  type VoiceDraftActions
} from './voice-draft-store.js'

const actions = (): VoiceDraftActions => ({ edit: vi.fn(), change: vi.fn(), done: vi.fn(), send: vi.fn() })
const draft = { threadKey: 't1', text: 'hello there', state: 'streaming' as const, editing: false }

describe('voice draft store', () => {
  let owner = actions()
  afterEach(() => clearVoiceDraft(owner))

  it('shows a published draft only in its own thread', () => {
    owner = actions()
    publishVoiceDraft(draft, owner)
    expect(voiceDraftFor('t1')).toEqual(draft)
    expect(voiceDraftFor('t2')).toBeNull()
    expect(voiceDraftActions()).toBe(owner)
  })

  it('follows each update from the publisher', () => {
    owner = actions()
    publishVoiceDraft(draft, owner)
    publishVoiceDraft({ ...draft, text: 'hello there friend', state: 'paused', editing: true }, owner)
    expect(voiceDraftFor('t1')).toMatchObject({ text: 'hello there friend', state: 'paused', editing: true })
  })

  it('clears only for the current publisher, so a stale input area cannot wipe a new one', () => {
    const stale = actions()
    owner = actions()
    publishVoiceDraft(draft, stale)
    publishVoiceDraft({ ...draft, text: 'from the new input area' }, owner)

    clearVoiceDraft(stale)
    expect(voiceDraftFor('t1')?.text).toBe('from the new input area')
    clearVoiceDraft(owner)
    expect(voiceDraftFor('t1')).toBeNull()
    expect(voiceDraftActions()).toBeNull()
  })
})
