import { test, expect } from '@playwright/test'

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  })

  test('US-SET-001: open settings modal via menu', async ({ page }) => {
    await page.getByTitle('Menu').click()
    await page.getByRole('button', { name: '⚙️ Settings' }).click()

    // Settings modal visible with Appearance section
    await expect(page.getByText('Appearance')).toBeVisible()
    // Theme options visible inside modal
    const modal = page.locator('.fixed.inset-0').last()
    await expect(modal.getByText('Dark')).toBeVisible()
    await expect(modal.getByText('Light')).toBeVisible()
  })

  test('US-SET-001b: close settings modal with X button', async ({ page }) => {
    await page.getByTitle('Menu').click()
    await page.getByRole('button', { name: '⚙️ Settings' }).click()
    await expect(page.getByText('Appearance')).toBeVisible()

    // Click close button
    await page.locator('button').filter({ hasText: '✕' }).click()
    await expect(page.getByText('Appearance')).not.toBeVisible()
  })

  test('US-SET-001c: close settings modal by clicking backdrop', async ({ page }) => {
    await page.getByTitle('Menu').click()
    await page.getByRole('button', { name: '⚙️ Settings' }).click()
    await expect(page.getByText('Appearance')).toBeVisible()

    // Click the backdrop overlay
    const backdrop = page.locator('[style*="backdrop-filter"]')
    await backdrop.click({ position: { x: 10, y: 10 }, force: true })
    await expect(page.getByText('Appearance')).not.toBeVisible()
  })

  test('US-SET-002: change setting and it applies immediately', async ({ page }) => {
    await page.getByTitle('Menu').click()
    await page.getByRole('button', { name: '⚙️ Settings' }).click()

    const modal = page.locator('.fixed.inset-0').last()
    await modal.getByText('JARVIS').click()
    await expect(page.locator('html')).toHaveClass(/jarvis/)
  })

  test('US-SET-002b: settings persist after modal close and page reload', async ({ page }) => {
    await page.getByTitle('Menu').click()
    await page.getByRole('button', { name: '⚙️ Settings' }).click()

    const modal = page.locator('.fixed.inset-0').last()
    await modal.getByText('Light').click()
    await expect(page.locator('html')).toHaveClass(/light/)

    await page.locator('button').filter({ hasText: '✕' }).click()
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('html')).toHaveClass(/light/)
  })
})
