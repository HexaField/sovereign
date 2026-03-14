import { test, expect } from '@playwright/test'

test.describe('Theme Switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.removeItem('sovereign:theme'))
    await page.reload()
    await page.waitForLoadState('networkidle')
  })

  test('US-THEME-001: switch between default, light, ironman, jarvis themes', async ({ page }) => {
    // Open settings
    await page.getByTitle('Menu').click()
    await page.getByRole('button', { name: '⚙️ Settings' }).click()
    await expect(page.getByText('Appearance')).toBeVisible()

    // Click Light theme button (inside settings modal)
    const modal = page.locator('.fixed.inset-0').last()
    await modal.getByText('Light').click()
    await expect(page.locator('html')).toHaveClass(/light/)

    // Click Iron Man theme
    await modal.getByText('Iron Man').click()
    await expect(page.locator('html')).toHaveClass(/ironman/)

    // Click JARVIS theme
    await modal.getByText('JARVIS').click()
    await expect(page.locator('html')).toHaveClass(/jarvis/)

    // Click Dark (default) theme
    await modal.getByText('Dark').click()
    const classes = await page.locator('html').getAttribute('class')
    expect(classes).not.toContain('light')
    expect(classes).not.toContain('ironman')
    expect(classes).not.toContain('jarvis')
  })

  test('US-THEME-002: theme preference persists across page reload', async ({ page }) => {
    // Open settings, pick ironman
    await page.getByTitle('Menu').click()
    await page.getByRole('button', { name: '⚙️ Settings' }).click()
    const modal = page.locator('.fixed.inset-0').last()
    await modal.getByText('Iron Man').click()
    await expect(page.locator('html')).toHaveClass(/ironman/)

    // Reload and verify
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('html')).toHaveClass(/ironman/)

    const stored = await page.evaluate(() => localStorage.getItem('sovereign:theme'))
    expect(stored).toBe('ironman')
  })
})
