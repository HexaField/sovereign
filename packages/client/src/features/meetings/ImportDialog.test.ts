import { describe, it, expect } from 'vitest'
import { ImportDialog, createImportForm, validateImportForm } from './ImportDialog.js'
import type { ImportFormData } from './ImportDialog.js'

describe('§8.9.1 Import Dialog', () => {
  it('§8.9.1 MUST allow uploading external meeting files', () => {
    expect(typeof ImportDialog).toBe('function')
  })

  it('§8.9.1 MUST accept title, threadKey, platform, startedAt, tags fields', () => {
    const form = createImportForm()
    expect(form).toHaveProperty('title')
    expect(form).toHaveProperty('threadKey')
    expect(form).toHaveProperty('platform')
    expect(form).toHaveProperty('startedAt')
    expect(form).toHaveProperty('tags')
  })

  it('§8.9.1 MUST accept audio or transcript file (or both)', () => {
    const form = createImportForm()
    expect(form).toHaveProperty('audioFile')
    expect(form).toHaveProperty('transcriptFile')

    // Validation requires at least one file
    expect(validateImportForm({ ...form, title: 'Test' })).toBe('Audio or transcript file is required')
    expect(validateImportForm({ ...form, title: '' })).toBe('Title is required')
    expect(validateImportForm({ ...form, title: 'Test', audioFile: new File([], 'a.wav') as any })).toBeNull()
  })
})
