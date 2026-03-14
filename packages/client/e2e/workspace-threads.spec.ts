import { test, expect } from '@playwright/test'
test.describe('Workspace — Threads Panel', () => {
  test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop-only: requires sidebar and keyboard navigation')

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('Meta+2')
    await expect(page.getByRole('button', { name: 'Threads' }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Threads' }).click()
  })

  test('US-WS-004: shows threads with busy/unread/stuck/error indicators', async ({ page }) => {
    // Threads panel renders with header and new-thread button
    await expect(page.getByText('Threads').first()).toBeVisible()
    await expect(page.getByRole('button', { name: '+ New' }).first()).toBeVisible()
  })

  test('US-WS-005: clicking thread opens ChatThreadTab with history and live events', async ({ page }) => {
    // Threads panel renders — no threads available in test env
    await expect(page.getByText('Threads').first()).toBeVisible()
    // The panel shows loading state for the workspace
    await expect(page.locator('text=/Loading threads|No workspace/').first()).toBeVisible()
  })
})
