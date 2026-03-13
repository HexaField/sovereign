import { describe, it } from 'vitest'

describe('Planning WebSocket', () => {
  describe('2.3 WebSocket Integration', () => {
    it.todo('MUST register a "planning" WS channel')
    it.todo('MUST send planning.graph.updated when dependency graph changes')
    it.todo('MUST send planning.sync.completed on sync completion')
    it.todo('MUST send planning.cycle.detected when cycles found')
    it.todo('MUST support scope subscription by { orgId }')
    it.todo('MUST only send updates to clients subscribed to the relevant orgId')
  })
})
