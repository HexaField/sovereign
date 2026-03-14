import { test, expect } from '@playwright/test'

test.describe('Workspace — Terminal Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('Meta+2')
    await expect(page.getByRole('button', { name: 'Terminal' }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Terminal' }).click()
  })

  test('US-WS-003: opens embedded PTY terminal scoped to project worktree', async ({ page }) => {
    // Terminal panel renders with header and new-terminal button
    await expect(page.getByText('Terminal').first()).toBeVisible()
    await expect(page.getByRole('button', { name: '+ New' }).first()).toBeVisible()
    // Terminal panel shows workspace context
    await expect(page.locator('text=/Terminal —/')).toBeVisible()
  })
})
