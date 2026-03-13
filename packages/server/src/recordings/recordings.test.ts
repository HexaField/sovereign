import { describe, it } from 'vitest'

describe('Recordings Service', () => {
  describe('§9.4 — Recording Endpoints', () => {
    it.todo('§9.4 — GET /api/orgs/:orgId/recordings lists recordings')
    it.todo('§9.4 — POST /api/orgs/:orgId/recordings uploads new recording (multipart)')
    it.todo('§9.4 — GET /api/orgs/:orgId/recordings/:id returns recording metadata')
    it.todo('§9.4 — GET /api/orgs/:orgId/recordings/:id/audio downloads audio file')
    it.todo('§9.4 — GET /api/orgs/:orgId/recordings/:id/transcript returns transcript')
    it.todo('§9.4 — DELETE /api/orgs/:orgId/recordings/:id deletes recording')
    it.todo('§9.4 — POST /api/orgs/:orgId/recordings/:id/transcribe triggers transcription')
    it.todo('§9.4 — storage at {dataDir}/recordings/{orgId}/{id}.webm and {id}.json')
  })

  describe('§9.1 — Thread Filtering', () => {
    it.todo('§9.1 — GET /api/threads?orgId=:orgId filters threads by workspace')
    it.todo('§9.1 — GET /api/threads without orgId returns all threads')
    it.todo('§9.1 — global threads returned when orgId=_global or no orgId specified')
  })
})
