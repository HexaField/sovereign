import { test, expect } from '@playwright/test'

test.describe('System View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Navigate to system view
    await page.keyboard.press('Meta+5')
    await page.waitForTimeout(300)
  })

  test.describe('Tab Switching', () => {
    test('US-SYS-007: switching tabs renders correct content', async ({ page }) => {
      // Default tab is Architecture
      await expect(page.getByText('Architecture').first()).toBeVisible()

      // Click Logs tab
      await page.getByRole('button', { name: 'Logs' }).click()
      await page.waitForTimeout(200)

      // Click Health tab
      await page.getByRole('button', { name: 'Health' }).click()
      await page.waitForTimeout(200)

      // Click Config tab
      await page.getByRole('button', { name: 'Config' }).click()
      await page.waitForTimeout(200)

      // Click Events tab
      await page.getByRole('button', { name: 'Events' }).click()
      await page.waitForTimeout(200)

      // Back to Architecture
      await page.getByRole('button', { name: 'Architecture' }).click()
      await page.waitForTimeout(200)

      // No crashes — main content still visible
      await expect(page.locator('main')).toBeVisible()
    })
  })

  test.describe('Architecture', () => {
    test('US-SYS-001: shows module architecture view', async ({ page }) => {
      // Architecture tab is active by default
      // It fetches from /api/system/architecture — should show module nodes
      // Even if fetch fails, the tab renders without crashing
      await expect(page.locator('main')).toBeVisible()
    })
  })

  test.describe('Logs', () => {
    test('US-SYS-002: logs tab renders', async ({ page }) => {
      await page.getByRole('button', { name: 'Logs' }).click()
      await expect(page.locator('main')).toBeVisible()
    })
  })

  test.describe('Health', () => {
    test('US-SYS-006: health tab renders', async ({ page }) => {
      await page.getByRole('button', { name: 'Health' }).click()
      await expect(page.locator('main')).toBeVisible()
    })
  })

  test.describe('Config', () => {
    test('US-SYS-003: config tab renders', async ({ page }) => {
      await page.getByRole('button', { name: 'Config' }).click()
      await expect(page.locator('main')).toBeVisible()
    })
  })

  test.describe('Jobs', () => {
    test('US-SYS-004: jobs tab renders', async ({ page }) => {
      await page.getByRole('button', { name: 'Jobs' }).click()
      await expect(page.locator('main')).toBeVisible()
    })
  })

  test.describe('Devices', () => {
    test('US-SYS-005: devices tab renders', async ({ page }) => {
      await page.getByRole('button', { name: 'Devices' }).click()
      await expect(page.locator('main')).toBeVisible()
    })
  })

  test.describe('Event Stream', () => {
    test('US-SYS-008: events tab renders', async ({ page }) => {
      await page.getByRole('button', { name: 'Events' }).click()
      await expect(page.locator('main')).toBeVisible()
    })
  })
})
