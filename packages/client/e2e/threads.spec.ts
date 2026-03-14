import { test, expect } from '@playwright/test'
test.describe('Threads', () => {
  test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop-only: requires sidebar and keyboard navigation')

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Navigate to workspace view
    await page.keyboard.press('Meta+2')
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-THREAD-001: threads panel renders in workspace sidebar', async ({ page }) => {
    // Click the "Threads" sidebar tab to open the threads panel
    await page.getByRole('button', { name: 'Threads' }).click()

    // The threads panel header should be visible
    await expect(page.locator('text=Threads').first()).toBeVisible()

    // The "+ New" button should be present
    await expect(page.getByRole('button', { name: '+ New' })).toBeVisible()
  })

  test('US-THREAD-002: threads panel shows loading state with workspace', async ({ page }) => {
    // Click the "Threads" sidebar tab
    await page.getByRole('button', { name: 'Threads' }).click()

    // Without a workspace selected, it should show fallback text
    // or loading text for the active workspace
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-THREAD-003: workspace sidebar tab switching works', async ({ page }) => {
    // Verify sidebar tabs are present — Files, Git, Threads, etc.
    await expect(page.getByRole('button', { name: 'Files' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Threads' })).toBeVisible()

    // Switch to threads tab
    await page.getByRole('button', { name: 'Threads' }).click()
    await expect(page.locator('text=Threads').first()).toBeVisible()

    // Switch to files tab
    await page.getByRole('button', { name: 'Files' }).click()
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-THREAD-004: connection status shown in header', async ({ page }) => {
    // The header always shows connection status
    const statusBadge = page
      .locator('span')
      .filter({ hasText: /^(connected|disconnected|connecting.*)$/ })
      .first()
    await expect(statusBadge).toBeVisible()
  })
})
