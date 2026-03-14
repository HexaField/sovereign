import { describe, it } from 'vitest'

describe('§8.2.3 Speaker Label Management', () => {
  it.todo('§8.2.3 MUST allow assigning human-readable labels to speaker IDs')
  it.todo('§8.2.3 MUST persist speaker labels across meetings')
  it.todo('§8.2.3 SHOULD suggest same mapping for known speaker IDs in future meetings')
  it.todo('§8.2.3 MUST store speaker label mappings per-org in {dataDir}/meetings/{orgId}/speakers.json')
  it.todo('§8.2.3 MUST support PATCH /api/orgs/:orgId/meetings/:id/speakers to update speaker labels')
  it.todo('§8.2.3 MUST support GET /api/orgs/:orgId/speakers to return org-wide speaker label history')
  it.todo('§8.2.3 Speaker label assignment MUST NOT re-trigger transcription')
})
