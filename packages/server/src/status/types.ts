export interface StatusUpdate {
  type: 'status.update'
  payload: {
    connection: 'connected' | 'disconnected' | 'reconnecting'
    activeJobs: number
    unreadNotifications: number
    org?: string
    project?: string
    modules: { name: string; status: 'ok' | 'degraded' | 'error' }[]
  }
}
