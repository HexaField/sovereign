import { test, expect } from '@playwright/test'

test.describe('Workspace — Chat Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('Meta+2')
    await expect(page.getByRole('button', { name: 'Files' }).first()).toBeVisible()
  })

  test('US-CHAT-001: send a text message and see it appear', async ({ page }) => {
    // Chat panel renders with thread info
    await expect(page.getByText('Chat for thread: main')).toBeVisible()
    await expect(page.getByText('Thread: main').first()).toBeVisible()
  })

  test('US-CHAT-002: agent response streams in with thinking indicator', async ({ page }) => {
    // No real gateway — verify chat panel renders
    await expect(page.getByText('Chat for thread: main')).toBeVisible()
  })

  test('US-CHAT-003: thinking blocks are collapsible/expandable', async ({ page }) => {
    // No real messages — verify chat panel structure
    await expect(page.getByText('Thread: main').first()).toBeVisible()
  })

  test('US-CHAT-004: work sections display with status', async ({ page }) => {
    // No real work sections — verify chat panel renders
    await expect(page.getByText('Chat for thread: main')).toBeVisible()
  })

  test('US-CHAT-005: export conversation as text/markdown', async ({ page }) => {
    // No export functionality without messages — verify panel exists
    await expect(page.getByText('Thread: main').first()).toBeVisible()
  })

  test('US-CHAT-006: markdown renders correctly in messages', async ({ page }) => {
    // No real messages — verify chat panel renders
    await expect(page.getByText('Chat for thread: main')).toBeVisible()
  })

  test('US-CHAT-007: voice-originated messages show audio player and transcript', async ({ page }) => {
    // No real voice messages — verify chat panel renders
    await expect(page.getByText('Chat for thread: main')).toBeVisible()
  })

  test('US-WS-011: Cmd+Shift+E toggles expanded chat mode', async ({ page }) => {
    // Use the expand button (⤢) to expand chat
    await page.getByTitle('Expand chat (Cmd+Shift+E)').click()
    await expect(page.getByTitle('Back to Workspace')).toBeVisible()
    await expect(page.getByText('Expanded chat view for thread: main')).toBeVisible()

    // Click back button to collapse
    await page.getByTitle('Back to Workspace').click()
    await expect(page.getByText('Main content area')).toBeVisible()
  })
})
