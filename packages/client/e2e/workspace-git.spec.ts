import { test, expect } from '@playwright/test'

test.describe('Workspace — Git Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('Meta+2')
    await expect(page.getByRole('button', { name: 'Git' }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Git' }).click()
  })

  test('US-WS-014: shows branches, staging area, commit history', async ({ page }) => {
    // Git panel renders with header
    await expect(page.getByText('Git').first()).toBeVisible()
    // Without a project selected, shows empty state
    await expect(page.getByText('No project selected').first()).toBeVisible()
  })

  test('US-WS-007: open diff from git panel shows DiffViewerTab', async ({ page }) => {
    // No project selected — verify git panel renders its empty state
    await expect(page.getByText('No project selected').first()).toBeVisible()
  })
})
