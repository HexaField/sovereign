import { describe, it } from 'vitest'

describe('§7 Dashboard', () => {
  describe('§7.1 DashboardView', () => {
    it.todo('MUST be the default view for global threads (main or bespoke)')
    it.todo('MUST auto-refresh all sections via Phase 3 WS subscriptions')
    it.todo('MUST use Tailwind utilities with var(--c-*) theme tokens')
    it.todo('MUST use responsive grid: 1 col mobile, 2 col tablet, 3 col desktop')
  })

  describe('§7.2 Clock', () => {
    it.todo('MUST show current time in large text, auto-updating every second')
    it.todo('MUST respect user locale via Intl.DateTimeFormat')
  })

  describe('§7.3 HealthPanel', () => {
    it.todo('MUST show agent backend connection status using ConnectionBadge')
    it.todo('MUST show connected services with their status')
    it.todo('MUST show server uptime formatted as Xd Xh Xm')
    it.todo('MUST show status dot: green healthy, amber degraded, red error')
  })

  describe('§7.4 ActivityFeed', () => {
    it.todo('MUST show recent events across all workspaces in reverse-chronological order')
    it.todo('MUST include commits, active agents, running tests, open reviews, issue updates, worktree activity')
    it.todo('MUST show event icon, description, workspace label, relative timestamp')
    it.todo('MUST switch to entity-bound thread on click')
    it.todo('MUST show maximum 50 events with Load more pagination')
  })

  describe('§7.5 Notifications', () => {
    it.todo('MUST show unread notifications grouped by thread/entity')
    it.todo('MUST show NOTIFY-classified events with action prompt')
    it.todo('MUST switch to relevant thread on notification click')
    it.todo('MUST visually distinguish read notifications with muted opacity')
    it.todo('MUST subscribe to notifications WS channel')
  })

  describe('§7.6 Active Agents', () => {
    it.todo('MUST show currently working agent sessions with thread name')
    it.todo('MUST show agent status (working/thinking) and activity duration')
    it.todo('MUST switch to agent thread on click')
  })

  describe('§7.7 ThreadQuickSwitch', () => {
    it.todo('MUST show 5 most recently active threads')
    it.todo('MUST show thread display name, entity icon, relative time')
    it.todo('MUST switch to thread on click')
  })

  describe('§7.8 Optional Sections', () => {
    it.todo('SHOULD show weather information if configured')
    it.todo('MAY show planning summary from Phase 5')
  })
})
