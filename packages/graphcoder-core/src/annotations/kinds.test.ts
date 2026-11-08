import { describe, expect, it } from 'vitest'
import { createMemoryFiles } from '../memory-files.js'
import {
  deleteKind,
  ensureKind,
  findKind,
  KIND_PALETTE,
  KINDS_FILE,
  loadKinds,
  syncKindsFromAnnotations,
  updateKind
} from './kinds.js'

describe('kind registry', () => {
  it('registers a kind on first use with a palette colour, and returns it after', async () => {
    const files = createMemoryFiles()
    const created = await ensureKind(files, ' Domain ', 'A bounded subsystem')
    expect(created).toMatchObject({ name: 'Domain', description: 'A bounded subsystem' })
    expect(KIND_PALETTE).toContain(created!.color)
    expect(await ensureKind(files, 'domain')).toEqual(created)
    expect(await loadKinds(files)).toEqual([created])
    expect(JSON.parse(files.files.get(KINDS_FILE)!)).toEqual([created])
  })

  it('ignores a blank name', async () => {
    const files = createMemoryFiles()
    expect(await ensureKind(files, '   ')).toBeNull()
    expect(files.files.size).toBe(0)
  })

  it('gives each new kind a free colour while the palette lasts, the same for the same name', async () => {
    const files = createMemoryFiles()
    const names = KIND_PALETTE.map((_, i) => `kind-${i}`)
    for (const name of names) await ensureKind(files, name)
    const colours = (await loadKinds(files)).map((k) => k.color)
    expect(new Set(colours).size).toBe(KIND_PALETTE.length)
    const again = createMemoryFiles()
    expect((await ensureKind(again, 'kind-3'))!.color).toBe((await ensureKind(createMemoryFiles(), 'KIND-3'))!.color)
  })

  it('finds kinds case-insensitively', () => {
    const kinds = [{ name: 'Data-Flow', color: '#000', description: '', createdAt: '' }]
    expect(findKind(kinds, 'data-flow')).toBe(kinds[0])
    expect(findKind(kinds, 'other')).toBeNull()
  })

  it('updates colour, description and name, refusing a blank or taken name', async () => {
    const files = createMemoryFiles()
    await ensureKind(files, 'domain')
    await ensureKind(files, 'concern')
    expect(await updateKind(files, 'DOMAIN', { color: '#123456', description: 'd' })).toMatchObject({
      name: 'domain',
      color: '#123456',
      description: 'd'
    })
    expect(await updateKind(files, 'domain', { name: 'Concern' })).toBeNull()
    expect(await updateKind(files, 'domain', { name: '  ' })).toBeNull()
    expect(await updateKind(files, 'missing', { color: '#fff' })).toBeNull()
    expect(await updateKind(files, 'domain', { name: 'Subsystem' })).toMatchObject({ name: 'Subsystem' })
    expect((await loadKinds(files)).map((k) => k.name)).toEqual(['Subsystem', 'concern'])
  })

  it('deletes a kind', async () => {
    const files = createMemoryFiles()
    await ensureKind(files, 'domain')
    expect(await deleteKind(files, 'Domain')).toBe(true)
    expect(await deleteKind(files, 'domain')).toBe(false)
    expect(await loadKinds(files)).toEqual([])
  })

  it('registers kinds in use that the registry lacks, writing only when it adds one', async () => {
    const files = createMemoryFiles()
    await ensureKind(files, 'domain')
    const written = files.files.get(KINDS_FILE)
    expect((await syncKindsFromAnnotations(files, ['Domain', '', 'domain'])).map((k) => k.name)).toEqual(['domain'])
    expect(files.files.get(KINDS_FILE)).toBe(written)
    const synced = await syncKindsFromAnnotations(files, ['concern', 'risk', 'Concern'])
    expect(synced.map((k) => k.name)).toEqual(['domain', 'concern', 'risk'])
    expect(new Set(synced.map((k) => k.color)).size).toBe(3)
    expect(await loadKinds(files)).toEqual(synced)
  })

  it('reads a registry leniently: missing fields filled, nameless or non-object entries dropped, junk empty', async () => {
    const files = createMemoryFiles({ [KINDS_FILE]: JSON.stringify([{ name: 'a' }, { color: '#fff' }, 3, null]) })
    expect(await loadKinds(files)).toEqual([{ name: 'a', color: KIND_PALETTE[0], description: '', createdAt: '' }])
    expect(await loadKinds(createMemoryFiles({ [KINDS_FILE]: '{' }))).toEqual([])
    expect(await loadKinds(createMemoryFiles({ [KINDS_FILE]: '{}' }))).toEqual([])
  })
})
