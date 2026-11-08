import { describe, expect, it } from 'vitest'
import { createMemoryFiles } from '../memory-files.js'
import {
  createAnnotation,
  deleteAnnotation,
  isSlug,
  loadAllAnnotations,
  loadAnnotation,
  parseAnnotation,
  saveAnnotation,
  slugify
} from './store.js'
import type { AnnotationMember } from './types.js'

const member = (ref: string, file = 'src/auth/service.ts'): AnnotationMember => ({
  id: ref.length.toString(16).padStart(64, '0'),
  ref,
  file,
  note: ''
})

describe('slugify', () => {
  it('lowercases, dashes runs of other characters and trims dashes', () => {
    expect(slugify('Authentication System')).toBe('authentication-system')
    expect(slugify('  Login -> Session!! ')).toBe('login-session')
    expect(slugify('Café Flow')).toBe('cafe-flow')
    expect(slugify('***')).toBe('untitled')
  })

  it('always produces a slug', () => {
    for (const label of ['Authentication System', '日本語', '../../etc/passwd', 'A_B'])
      expect(isSlug(slugify(label))).toBe(true)
    expect(isSlug('../x')).toBe(false)
    expect(isSlug('a.conversation')).toBe(false)
  })
})

describe('annotation store', () => {
  it('writes the committed v3 file: sorted keys, two-space indent, trailing newline, no derived fields', async () => {
    const files = createMemoryFiles()
    const slug = await saveAnnotation(
      files,
      createAnnotation('Authentication System', [member('AuthService.login')], {
        kind: 'domain',
        description: 'Session-based auth'
      })
    )
    expect(slug).toBe('authentication-system')
    const text = files.files.get('.graphcoder/annotations/authentication-system.json')!
    expect(text).toBe(
      [
        '{',
        '  "description": "Session-based auth",',
        '  "kind": "domain",',
        '  "label": "Authentication System",',
        '  "members": [',
        '    {',
        `      "file": "src/auth/service.ts",`,
        `      "id": "${member('AuthService.login').id}",`,
        '      "note": "",',
        '      "ref": "AuthService.login"',
        '    }',
        '  ],',
        '  "ordered": false',
        '}',
        ''
      ].join('\n')
    )
  })

  it('round-trips an annotation, its module spec and an agent proposal', async () => {
    const files = createMemoryFiles()
    const module = {
      paths: ['src/db/**', '!src/db/legacy'],
      lanes: ['data'],
      tier: 'storage',
      dependsOn: [{ module: 'api', via: 'HTTP' }]
    }
    const proposal = createAnnotation('Login Flow', [member('a'), member('bb')], {
      kind: 'data-flow',
      ordered: true,
      status: 'proposed',
      author: 'agent',
      reasoning: 'traced from the route',
      module
    })
    const slug = await saveAnnotation(files, proposal)
    const loaded = await loadAnnotation(files, slug)
    expect(loaded).toEqual({ ...proposal, id: 'login-flow', shape: 'polyline' })
    // Saving what was loaded writes the same bytes
    const before = files.files.get(`.graphcoder/annotations/${slug}.json`)
    await saveAnnotation(files, loaded!)
    expect(files.files.get(`.graphcoder/annotations/${slug}.json`)).toBe(before)
  })

  it('derives shape from ordered and member count', async () => {
    expect(createAnnotation('x', []).shape).toBe('point')
    expect(createAnnotation('x', [member('a')]).shape).toBe('point')
    expect(createAnnotation('x', [member('a'), member('bb')]).shape).toBe('region')
    expect(createAnnotation('x', [member('a')], { ordered: true }).shape).toBe('polyline')
  })

  it('gives a new annotation a free slug and keeps an existing one on save', async () => {
    const files = createMemoryFiles()
    expect(await saveAnnotation(files, createAnnotation('Auth', []))).toBe('auth')
    expect(await saveAnnotation(files, createAnnotation('Auth', []))).toBe('auth-2')
    expect(await saveAnnotation(files, createAnnotation('auth!', []))).toBe('auth-3')
    const existing = (await loadAnnotation(files, 'auth'))!
    expect(await saveAnnotation(files, { ...existing, label: 'Renamed' })).toBe('auth')
    expect((await loadAnnotation(files, 'auth'))!.label).toBe('Renamed')
  })

  it('refuses a slug that is not one, so no path outside the annotations directory is touched', async () => {
    const files = createMemoryFiles({ '.graphcoder/secret.json': '{}' })
    await expect(loadAnnotation(files, '../secret')).rejects.toThrow(/Not an annotation slug/)
    await expect(deleteAnnotation(files, '../secret')).rejects.toThrow(/Not an annotation slug/)
    await expect(saveAnnotation(files, { ...createAnnotation('x', []), id: 'a/b' })).rejects.toThrow()
    expect(files.files.has('.graphcoder/secret.json')).toBe(true)
  })

  it('loads every v3 annotation and skips conversation logs, malformed files and older formats', async () => {
    const v3 = (label: string) => JSON.stringify({ kind: 'k', label, description: '', ordered: false, members: [] })
    const files = createMemoryFiles({
      '.graphcoder/annotations/b.json': v3('B'),
      '.graphcoder/annotations/a.json': v3('A'),
      '.graphcoder/annotations/0f1c.conversation.json': '{"turns":[]}',
      '.graphcoder/annotations/broken.json': '{not json',
      // v2: members were bare semantic ids, shape a string
      '.graphcoder/annotations/old.json': JSON.stringify({ shape: 'region', label: 'Old', members: ['abc'] }),
      '.graphcoder/annotations/notes.txt': 'x'
    })
    expect((await loadAllAnnotations(files)).map((a) => a.id)).toEqual(['a', 'b'])
    expect(await loadAllAnnotations(createMemoryFiles())).toEqual([])
  })

  it('normalises what it reads: strings for member fields, a valid module spec, status active unless proposed', () => {
    const parsed = parseAnnotation(
      {
        kind: 'module',
        label: 'Db',
        ordered: false,
        status: 'stale',
        members: [{ id: 'x', ref: 3 }],
        module: {
          paths: ['src/db', '', 4],
          lanes: ['a', 'b', 'c'],
          layer: -1,
          tier: ' t ',
          dependsOn: [{ module: '' }, { module: 'api' }]
        }
      },
      'db'
    )
    expect(parsed).toMatchObject({
      id: 'db',
      status: 'active',
      description: '',
      members: [{ id: 'x', ref: '3', file: '', note: '' }],
      module: { paths: ['src/db'], lanes: ['a', 'b'], tier: 't', dependsOn: [{ module: 'api', via: '' }] }
    })
    expect(parsed!.module!.layer).toBeUndefined()
    expect(parseAnnotation([], 'x')).toBeNull()
    expect(parseAnnotation({ ordered: false, members: ['bare-id'] }, 'x')).toBeNull()
  })

  it('deletes by slug', async () => {
    const files = createMemoryFiles()
    const slug = await saveAnnotation(files, createAnnotation('Gone', []))
    expect(await deleteAnnotation(files, slug)).toBe(true)
    expect(await deleteAnnotation(files, slug)).toBe(false)
    expect(await loadAnnotation(files, slug)).toBeNull()
  })
})
