export interface Notification {
  id: string
  timestamp: string
  severity: 'info' | 'warning' | 'error' | 'critical'
  title: string
  body: string
  source: string
  read: boolean
  dismissed: boolean
  group?: string
  action?: { type: string; payload: Record<string, unknown> }
}

export interface NotificationRule {
  eventPattern: string
  severity: Notification['severity']
  titleTemplate: string
  bodyTemplate: string
  group?: string
}
