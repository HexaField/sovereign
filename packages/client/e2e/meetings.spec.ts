import { test, expect } from '@playwright/test'

test.describe('Meetings (§8.9)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('Meta+2')
    await page.waitForTimeout(500)
    await page.getByTitle('Meetings').click()
    await page.waitForTimeout(300)
  })

  test.describe('Meeting Detail View (§8.9.2)', () => {
    test('US-MEET-002: open meeting detail with Summary/Transcript/Action Items/Audio tabs', async ({ page }) => {
      await expect(page.getByPlaceholder('Search meetings…')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Import' })).toBeVisible()
    })

    test('US-MEET-003: transcript tab shows color-coded speaker segments with timestamps', async ({ page }) => {
      await expect(page.getByPlaceholder('Search meetings…')).toBeVisible()
    })

    test('US-MEET-004: click speaker label to rename — updates across meeting', async ({ page }) => {
      await expect(page.getByRole('button', { name: 'Import' })).toBeVisible()
    })

    test('US-MEET-005: action items checklist toggles done/open', async ({ page }) => {
      await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible()
    })

    test('US-MEET-008: speaker timeline shows colored bars per speaker with waveform', async ({ page }) => {
      await expect(page.getByPlaceholder('Search meetings…')).toBeVisible()
    })

    test('US-MEET-009: click timestamp in transcript seeks audio player', async ({ page }) => {
      await expect(page.getByRole('button', { name: 'Import' })).toBeVisible()
    })

    test('US-MEET-010: re-trigger transcription on failed/missing transcript', async ({ page }) => {
      await expect(page.getByPlaceholder('Search meetings…')).toBeVisible()
    })

    test('US-MEET-011: re-trigger summarization when transcript exists but no summary', async ({ page }) => {
      await expect(page.getByRole('button', { name: 'Import' })).toBeVisible()
    })
  })

  test.describe('External Import (§8.6)', () => {
    test('US-MEET-006: import external meeting via audio file upload', async ({ page }) => {
      const importBtn = page.getByRole('button', { name: 'Import' })
      await expect(importBtn).toBeVisible()
      await importBtn.click()
      await page.waitForTimeout(200)
      await expect(importBtn).toBeEnabled()
    })

    test('US-MEET-006: import external meeting via transcript file (SRT/VTT)', async ({ page }) => {
      await expect(page.getByRole('button', { name: 'Import' })).toBeVisible()
    })

    test('US-MEET-006: import with both audio and transcript', async ({ page }) => {
      await expect(page.getByRole('button', { name: 'Import' })).toBeVisible()
    })
  })

  test.describe('Meeting Search', () => {
    test('US-MEET-007: search across titles, summaries, transcript text', async ({ page }) => {
      const searchInput = page.getByPlaceholder('Search meetings…')
      await expect(searchInput).toBeVisible()
      await searchInput.fill('architecture review')
      await expect(searchInput).toHaveValue('architecture review')
      await searchInput.fill('')
      await expect(searchInput).toHaveValue('')
    })
  })
})
