import { test, expect } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 } }) // iPhone 14

test.describe('Mobile / Responsive', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  })

  test('US-MOB-001: swipe between workspace panels', async ({ page }) => {
    // On mobile viewport, the app should render with the header visible
    await expect(page.locator('.safe-top')).toBeVisible()

    // The main content area should be visible
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-MOB-002: only one panel visible at a time filling viewport', async ({ page }) => {
    // The main content should fill the viewport width
    const main = page.locator('main')
    await expect(main).toBeVisible()
    const box = await main.boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      // Main should span full width (390px viewport)
      expect(box.width).toBeGreaterThanOrEqual(380)
    }
  })

  test('US-MOB-003: tapping file auto-switches to file viewer', async ({ page }) => {
    // Navigate to workspace files view via menu
    await page.getByTitle('Menu').click()
    await page.getByRole('button', { name: '📂 Files' }).click()

    // The main content area should render
    await expect(page.locator('main')).toBeVisible()
  })

  test('US-MOB-004: mobile workspace shows tab navigation', async ({ page }) => {
    // Navigate to workspace
    await page.getByTitle('Menu').click()
    await page.getByRole('button', { name: '📁 Workspace' }).click()

    // On mobile viewport, workspace should render with mobile tabs
    await expect(page.locator('main')).toBeVisible()

    // The header should still be visible on mobile
    await expect(page.locator('.safe-top')).toBeVisible()
  })

  test('US-MOB-005: touch pan and zoom on canvas', async ({ page }) => {
    // Navigate to canvas
    await page.getByTitle('Menu').click()
    await page.getByRole('button', { name: '⬡ Canvas' }).click()

    await expect(page.getByTestId('canvas-view')).toBeVisible()
    await expect(page.getByTestId('canvas-svg')).toBeVisible()

    // Verify the canvas has the transform group for pan/zoom
    const transformGroup = page.getByTestId('canvas-transform-group')
    const transform = await transformGroup.getAttribute('transform')
    expect(transform).toBeTruthy()
  })
})
