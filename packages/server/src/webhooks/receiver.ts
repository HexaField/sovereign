import { Router, json } from 'express'
import { createHmac, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventBus } from '@template/core'
import type { WebhookEvent, ClassificationRule } from './types.js'
import { createWebhookStore, type WebhookStore } from './store.js'
import { createClassifier, type Classifier } from './classify.js'

export interface WebhookReceiver {
  router: Router
  rules(): ClassificationRule[]
  updateRules(rules: ClassificationRule[]): void
  events(filter?: { source?: string; classification?: string; limit?: number }): WebhookEvent[]
  replay(eventId: string): void
  stop(): void
}

interface SourceConfig {
  secret?: string
  signatureHeader?: string
}

export const createWebhookReceiver = (
  bus: EventBus,
  dataDir: string,
  sources?: Record<string, SourceConfig>
): WebhookReceiver => {
  const store: WebhookStore = createWebhookStore(dataDir)
  const classifier: Classifier = createClassifier(dataDir)
  const router = Router()

  router.use(json())

  const verifyGithubSignature = (payload: string, signature: string, secret: string): boolean => {
    const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex')
    return expected === signature
  }

  router.post('/api/hooks/:source', (req, res) => {
    const source = req.params.source
    const sourceConfig = sources?.[source]

    // Signature verification for sources that require it
    if (sourceConfig?.secret) {
      const sigHeader = sourceConfig.signatureHeader || 'x-hub-signature-256'
      const signature = req.headers[sigHeader] as string | undefined
      if (!signature) {
        res.status(401).json({ error: 'Missing signature' })
        return
      }
      const rawBody = JSON.stringify(req.body)
      if (!verifyGithubSignature(rawBody, signature, sourceConfig.secret)) {
        res.status(401).json({ error: 'Invalid signature' })
        return
      }
    }

    const classification = classifier.classify(source, req.body)

    const event: WebhookEvent = {
      id: randomUUID(),
      source,
      receivedAt: new Date().toISOString(),
      headers: req.headers as Record<string, string>,
      body: req.body,
      classification,
      ...(sourceConfig?.secret
        ? {
            signature: { algorithm: 'sha256', verified: true }
          }
        : {})
    }

    // Persist BEFORE processing
    store.persist(event)

    // Respond 200 immediately
    res.status(200).json({ id: event.id, classification: event.classification })

    // Emit on bus AFTER response
    bus.emit({
      type: 'webhook.received',
      timestamp: event.receivedAt,
      source: 'webhooks',
      payload: event
    })
  })

  router.post('/api/hooks/:source/replay/:eventId', (req, res) => {
    const event = store.get(req.params.eventId)
    if (!event) {
      res.status(404).json({ error: 'Event not found' })
      return
    }

    bus.emit({
      type: 'webhook.received',
      timestamp: new Date().toISOString(),
      source: 'webhooks',
      payload: { ...event, replayed: true }
    })

    res.status(200).json({ replayed: true, id: event.id })
  })

  return {
    router,
    rules: () => classifier.rules(),
    updateRules: (_rules: ClassificationRule[]) => {
      // Write rules to disk — classifier will hot-reload
      writeFileSync(join(dataDir, 'webhooks', 'rules.json'), JSON.stringify(_rules, null, 2))
    },
    events: (filter) => store.list(filter),
    replay: (eventId: string) => {
      const event = store.get(eventId)
      if (event) {
        bus.emit({
          type: 'webhook.received',
          timestamp: new Date().toISOString(),
          source: 'webhooks',
          payload: { ...event, replayed: true }
        })
      }
    },
    stop: () => classifier.stop()
  }
}
