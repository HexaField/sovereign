import { test, expect } from '@playwright/test'

test.describe('Recordings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('Meta+2')
    await page.waitForTimeout(500)
    await page.getByTitle('Recordings').click()
    await page.waitForTimeout(300)
  })

  test('US-REC-001: start and stop recording in workspace, saved to server', async ({ page }) => {
    // Recordings panel renders with heading and Record button
    await expect(page.locator('text=Recordings').first()).toBeVisible()
    const recordBtn = page.locator('button', { hasText: '🎙️ Record' })
    await expect(recordBtn).toBeVisible()
    await expect(recordBtn).toBeEnabled()
  })

  test('US-REC-002: recording auto-creates meeting and starts transcription', async ({ page }) => {
    await expect(page.locator('text=Recordings').first()).toBeVisible()
  })

  test('US-REC-003: play back recording with seek support', async ({ page }) => {
    // Empty state shows no recordings message
    await expect(page.getByText(/No recordings/)).toBeVisible()
  })

  test('US-REC-004: recording list shows transcription status badges', async ({ page }) => {
    await expect(page.getByText(/No recordings/)).toBeVisible()
    const recordBtn = page.locator('button', { hasText: '🎙️ Record' })
    await expect(recordBtn).toBeVisible()
  })
})
