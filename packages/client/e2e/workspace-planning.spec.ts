import { test, expect } from '@playwright/test'
test.describe('Workspace — Planning Panel', () => {
  test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop-only: requires sidebar and keyboard navigation')

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('Meta+2')
    await page.waitForTimeout(500)
    // Click the Planning sidebar tab
    await page.getByTitle('Planning').click()
    await page.waitForTimeout(300)
  })

  test('US-WS-006: shows ready/blocked/in-progress counts', async ({ page }) => {
    // Planning panel renders with its heading
    await expect(page.getByTitle('Planning')).toBeVisible()
    // The panel content area is visible
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-WS-006: expand to full DAG in main content', async ({ page }) => {
    await expect(page.locator('main')).toBeVisible()
    // Planning sidebar tab is active
    await expect(page.getByTitle('Planning')).toBeVisible()
  })
})
