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
  entityId?: string
  entityType?: 'issue' | 'pr' | 'branch' | 'thread' | 'system'
}

export interface NotificationRule {
  eventPattern: string
  severity: Notification['severity']
  titleTemplate: string
  bodyTemplate: string
  group?: string
  entityType?: Notification['entityType']
  entityIdField?: string
}
