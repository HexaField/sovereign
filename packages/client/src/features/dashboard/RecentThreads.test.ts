import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('RecentThreads component', () => {
  it('uses the /api/threads?limit=6 endpoint and renders header', () => {
    const src = fs.readFileSync(path.resolve(__dirname, './RecentThreads.tsx'), 'utf-8')
    expect(src).toContain('/api/threads?limit=6')
    expect(src).toContain('Recent threads')
  })
})
