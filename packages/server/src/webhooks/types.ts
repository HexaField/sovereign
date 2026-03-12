export type WebhookClassification = 'void' | 'notify' | 'sync' | 'agent'

export interface WebhookEvent {
  id: string
  source: string
  receivedAt: string
  headers: Record<string, string>
  body: unknown
  classification: WebhookClassification
  signature?: { algorithm: string; verified: boolean }
}

export interface ClassificationRule {
  source: string
  match: Record<string, unknown>
  classification: WebhookClassification
  priority: number
}
