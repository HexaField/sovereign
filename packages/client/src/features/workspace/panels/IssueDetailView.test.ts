import { describe, it, expect } from 'vitest'
import { buildIssueDetailUrl, buildCommentsUrl } from './IssueDetailView.js'

describe('IssueDetailView', () => {
  it('exports default component', async () => {
    const mod = await import('./IssueDetailView.js')
    expect(mod.default).toBeDefined()
  })

  it('builds issue detail URL correctly', () => {
    expect(buildIssueDetailUrl('org1', 'proj1', '42')).toBe('/api/orgs/org1/projects/proj1/issues/42')
  })

  it('builds comments URL correctly', () => {
    expect(buildCommentsUrl('org1', 'proj1', '42')).toBe('/api/orgs/org1/projects/proj1/issues/42/comments')
  })

  it('encodes special characters in URL', () => {
    expect(buildIssueDetailUrl('org/1', 'proj 1', '42')).toBe('/api/orgs/org%2F1/projects/proj%201/issues/42')
  })
})
