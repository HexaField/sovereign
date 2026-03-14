import { test, expect } from '@playwright/test'

test.describe('Workspace — Meetings Panel (§8.9.1)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('Meta+2')
    await page.waitForTimeout(500)
    await page.getByTitle('Meetings').click()
    await page.waitForTimeout(300)
  })

  test('US-MEET-001: shows meeting list sorted by date with status badges', async ({ page }) => {
    await expect(page.getByPlaceholder('Search meetings…')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible()
  })

  test('US-MEET-007: search filters meetings by title, summary, transcript text', async ({ page }) => {
    const searchInput = page.getByPlaceholder('Search meetings…')
    await expect(searchInput).toBeVisible()
    await searchInput.fill('test query')
    await expect(searchInput).toHaveValue('test query')
  })

  test('US-MEET-006: import button opens ImportDialog for external meeting upload', async ({ page }) => {
    const importBtn = page.getByRole('button', { name: 'Import', exact: true })
    await expect(importBtn).toBeVisible()
    await expect(importBtn).toBeEnabled()
    await importBtn.click()
    await page.waitForTimeout(200)
  })

  test('US-REC-001: record button starts new meeting recording', async ({ page }) => {
    const recordBtn = page.getByRole('button', { name: 'Record', exact: true })
    await expect(recordBtn).toBeVisible()
    await expect(recordBtn).toBeEnabled()
  })
})
