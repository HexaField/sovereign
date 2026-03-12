import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Notification } from './types.js'

export interface NotificationStore {
  append(n: Notification): void
  readAll(): Notification[]
  readFiltered(filter?: { severity?: string; read?: boolean; limit?: number; offset?: number }): Notification[]
  overwrite(notifications: Notification[]): void
}

export const createNotificationStore = (dataDir: string): NotificationStore => {
  const dir = join(dataDir, 'notifications')
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'notifications.jsonl')

  const append = (n: Notification): void => {
    appendFileSync(filePath, JSON.stringify(n) + '\n')
  }

  const readAll = (): Notification[] => {
    if (!existsSync(filePath)) return []
    const content = readFileSync(filePath, 'utf-8').trim()
    if (!content) return []
    return content.split('\n').map((line) => JSON.parse(line) as Notification)
  }

  const readFiltered = (filter?: {
    severity?: string
    read?: boolean
    limit?: number
    offset?: number
  }): Notification[] => {
    let all = readAll()
    if (filter?.severity) all = all.filter((n) => n.severity === filter.severity)
    if (filter?.read !== undefined) all = all.filter((n) => n.read === filter.read)
    const offset = filter?.offset ?? 0
    const limit = filter?.limit ?? all.length
    return all.slice(offset, offset + limit)
  }

  const overwrite = (notifications: Notification[]): void => {
    const { writeFileSync } = require('node:fs')
    writeFileSync(filePath, notifications.map((n) => JSON.stringify(n)).join('\n') + (notifications.length ? '\n' : ''))
  }

  return { append, readAll, readFiltered, overwrite }
}
