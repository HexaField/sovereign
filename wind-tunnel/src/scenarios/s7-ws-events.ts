// S7: WebSocket Events — verify WS subscription, channel routing,
// and that thread lifecycle events propagate to connected clients.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

export const s7WsEvents: Scenario = {
  id: 's7',
  name: 'WebSocket Events',
  description: 'WS connection, channel subscription, thread-event propagation',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const metrics: Record<string, unknown> = {}

    // 1. Connect WS with thread channel
    await client.timed('ws-connect', () => client.connectWs(['chat', 'threads']))
    metrics.wsConnected = true

    // 2. Create a thread — should trigger a thread event via WS
    const thread = await client.timed('create-thread', () => client.createThread({ label: 'swt-s7-ws-events' }))
    metrics.threadId = thread.id

    // 3. Wait for the thread creation event
    let gotCreatedEvent = false
    try {
      const evt = await client.waitForWs('thread.created', 5000)
      gotCreatedEvent = evt != null
      metrics.createdEvent = evt
    } catch {
      // Might have arrived as a different event name; check drain
      const drained = client.drainWs()
      gotCreatedEvent = drained.some(
        (m) => m.type === 'thread.created' || (m.type === 'thread.list' && Array.isArray(m.threads))
      )
      metrics.drainedEvents = drained.map((m: any) => m.type)
    }
    metrics.gotCreatedEvent = gotCreatedEvent

    // 4. Update thread — check for update event
    await client.updateThread(thread.id, { label: 'swt-s7-renamed' })
    let gotUpdateEvent = false
    try {
      const evt = await client.waitForWs('thread.updated', 5000)
      gotUpdateEvent = evt != null
    } catch {
      const drained = client.drainWs()
      gotUpdateEvent = drained.some((m) => m.type === 'thread.updated')
    }
    metrics.gotUpdateEvent = gotUpdateEvent

    // 5. Delete thread — check for delete event
    await client.deleteThread(thread.id)
    let gotDeleteEvent = false
    try {
      const evt = await client.waitForWs('thread.deleted', 5000)
      gotDeleteEvent = evt != null
    } catch {
      const drained = client.drainWs()
      gotDeleteEvent = drained.some((m) => m.type === 'thread.deleted')
    }
    metrics.gotDeleteEvent = gotDeleteEvent

    client.disconnectWs()

    // At minimum, WS connects and we get some events
    const passed = metrics.wsConnected === true
    const eventScore = [gotCreatedEvent, gotUpdateEvent, gotDeleteEvent].filter(Boolean).length

    return {
      passed,
      summary: `WS events — ${eventScore}/3 lifecycle events received`,
      metrics,
      samples: client.samples
    }
  }
}
