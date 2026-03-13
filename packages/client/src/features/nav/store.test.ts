import { describe, it } from 'vitest'

describe('§3.5 Nav Store', () => {
  describe('viewMode', () => {
    it.todo('MUST expose viewMode accessor')
    it.todo('MUST default to chat when no URL query parameter')
    it.todo('MUST read initial viewMode from ?view= query parameter')
    it.todo('MUST update URL query parameter when setViewMode is called')
    it.todo('MUST use history.replaceState to avoid page reload')
    it.todo('MUST listen for popstate events and update viewMode')
    it.todo('MUST support all ViewMode values: chat, voice, dashboard, recording')
  })

  describe('drawerOpen', () => {
    it.todo('MUST expose drawerOpen accessor')
    it.todo('MUST default to false')
    it.todo('MUST toggle via setDrawerOpen')
  })

  describe('settingsOpen', () => {
    it.todo('MUST expose settingsOpen accessor')
    it.todo('MUST default to false')
    it.todo('MUST toggle via setSettingsOpen')
  })
})
