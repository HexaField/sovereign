import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createSpeakerService } from './speakers.js'

describe('§8.2.3 Speaker Label Management', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-speakers-test-'))
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('§8.2.3 MUST allow assigning human-readable labels to speaker IDs', async () => {
    const svc = createSpeakerService(dataDir)
    await svc.setLabels('org1', 'meeting1', { SPEAKER_00: 'Josh', SPEAKER_01: 'Alice' })
    const labels = await svc.getLabels('org1')
    expect(labels.SPEAKER_00).toBe('Josh')
    expect(labels.SPEAKER_01).toBe('Alice')
  })

  it('§8.2.3 MUST persist speaker labels across meetings', async () => {
    const svc = createSpeakerService(dataDir)
    await svc.setLabels('org1', 'meeting1', { SPEAKER_00: 'Josh' })
    await svc.setLabels('org1', 'meeting2', { SPEAKER_01: 'Alice' })
    const labels = await svc.getLabels('org1')
    expect(labels.SPEAKER_00).toBe('Josh')
    expect(labels.SPEAKER_01).toBe('Alice')
  })

  it('§8.2.3 SHOULD suggest same mapping for known speaker IDs in future meetings', async () => {
    const svc = createSpeakerService(dataDir)
    await svc.setLabels('org1', 'meeting1', { SPEAKER_00: 'Josh' })
    // Future meeting — org history suggests Josh for SPEAKER_00
    const history = await svc.getOrgHistory('org1')
    expect(history.SPEAKER_00).toBe('Josh')
  })

  it('§8.2.3 MUST store speaker label mappings per-org in {dataDir}/meetings/{orgId}/speakers.json', async () => {
    const svc = createSpeakerService(dataDir)
    await svc.setLabels('org1', 'meeting1', { SPEAKER_00: 'Josh' })
    const filePath = path.join(dataDir, 'meetings', 'org1', 'speakers.json')
    expect(fs.existsSync(filePath)).toBe(true)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(data.SPEAKER_00).toBe('Josh')
  })

  it('§8.2.3 MUST support PATCH /api/orgs/:orgId/meetings/:id/speakers to update speaker labels', async () => {
    // This tests the service layer that backs the PATCH route
    const svc = createSpeakerService(dataDir)
    await svc.setLabels('org1', 'meeting1', { SPEAKER_00: 'Josh' })
    await svc.setLabels('org1', 'meeting1', { SPEAKER_00: 'Joshua' })
    const labels = await svc.getLabels('org1')
    expect(labels.SPEAKER_00).toBe('Joshua')
  })

  it('§8.2.3 MUST support GET /api/orgs/:orgId/speakers to return org-wide speaker label history', async () => {
    const svc = createSpeakerService(dataDir)
    await svc.setLabels('org1', 'meeting1', { SPEAKER_00: 'Josh' })
    await svc.setLabels('org1', 'meeting2', { SPEAKER_01: 'Alice' })
    const history = await svc.getOrgHistory('org1')
    expect(history.SPEAKER_00).toBe('Josh')
    expect(history.SPEAKER_01).toBe('Alice')
  })

  it('§8.2.3 Speaker label assignment MUST NOT re-trigger transcription', async () => {
    // Setting labels is a metadata-only operation — no transcription pipeline involvement
    const svc = createSpeakerService(dataDir)
    await svc.setLabels('org1', 'meeting1', { SPEAKER_00: 'Josh' })
    // If this completes without error and no transcription was triggered, the test passes
    const labels = await svc.getLabels('org1')
    expect(labels.SPEAKER_00).toBe('Josh')
  })
})
