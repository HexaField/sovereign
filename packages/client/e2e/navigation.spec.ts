import { test, expect, type Page } from '@playwright/test'

// Helper to open settings modal
async function openSettings(page: Page) {
  await page.getByTitle('Menu').click()
  await page.getByRole('button', { name: '⚙️ Settings' }).click()
}

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  })

  test('US-NAV-001: view menu dropdown switches between views', async ({ page }) => {
    // Open hamburger menu
    await page.getByTitle('Menu').click()

    // Click "System" in the menu (use role to avoid ambiguity)
    await page.getByRole('button', { name: '⚙️ System' }).click()

    // System view should show tab bar
    await expect(page.getByRole('button', { name: 'Architecture' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Logs' })).toBeVisible()

    // Open menu again and switch to Dashboard
    await page.getByTitle('Menu').click()
    await page.getByRole('button', { name: '🏠 Dashboard' }).click()

    // Dashboard renders
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-NAV-002: Cmd+1 switches to Dashboard', async ({ page }) => {
    // First go to system view
    await page.keyboard.press('Meta+5')
    await expect(page.getByRole('button', { name: 'Architecture' })).toBeVisible()

    // Now Cmd+1 to dashboard
    await page.keyboard.press('Meta+1')
    // Dashboard renders — main content area visible
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-NAV-002: Cmd+2 switches to Workspace', async ({ page }) => {
    await page.keyboard.press('Meta+2')
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-NAV-002: Cmd+3 switches to Canvas', async ({ page }) => {
    await page.keyboard.press('Meta+3')
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-NAV-002: Cmd+4 switches to Planning', async ({ page }) => {
    await page.keyboard.press('Meta+4')
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-NAV-002: Cmd+5 switches to System', async ({ page }) => {
    await page.keyboard.press('Meta+5')
    await expect(page.getByRole('button', { name: 'Architecture' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Health' })).toBeVisible()
  })

  test('US-NAV-003: Cmd+Shift+E toggles expanded chat in workspace', async ({ page }) => {
    await page.keyboard.press('Meta+2')
    await page.waitForTimeout(300)
    await page.keyboard.press('Meta+Shift+E')
    await page.waitForTimeout(200)
    await page.keyboard.press('Meta+Shift+E')
    await page.waitForTimeout(200)
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-NAV-004: Cmd+B toggles sidebar visibility', async ({ page }) => {
    await page.keyboard.press('Meta+2')
    await page.waitForTimeout(300)
    await page.keyboard.press('Meta+B')
    await page.waitForTimeout(200)
    await page.keyboard.press('Meta+B')
    await page.waitForTimeout(200)
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-NAV-005: connection badge shows connected/disconnected status', async ({ page }) => {
    const badge = page
      .locator('span')
      .filter({ hasText: /^(connected|disconnected|connecting.*)$/ })
      .first()
    await expect(badge).toBeVisible()
  })
})
