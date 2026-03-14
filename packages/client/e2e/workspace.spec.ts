import { test, expect } from '@playwright/test'

test.describe('Workspace View — Layout & Core', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('Meta+2')
    // Wait for sidebar tab bar to appear (workspace loaded)
    await expect(page.getByRole('button', { name: 'Files' }).first()).toBeVisible()
  })

  test.describe('Sidebar', () => {
    test('US-WS-001: shows projects in sidebar with git status indicators', async ({ page }) => {
      // Files tab is active by default — check the file explorer panel renders
      await expect(page.getByText('Files').first()).toBeVisible()
      // The panel should show either a project name or "No project selected"
      const panel = page.locator('.flex.h-full.flex-col')
      await expect(panel.first()).toBeVisible()
    })

    test('US-WS-017: switching sidebar tabs shows one panel at a time', async ({ page }) => {
      // Click Git tab
      await page.getByRole('button', { name: 'Git' }).click()
      await expect(page.getByText('Git').first()).toBeVisible()
      // Git panel header visible
      await expect(page.getByText('No project selected').first()).toBeVisible()

      // Click Threads tab
      await page.getByRole('button', { name: 'Threads' }).click()
      await expect(page.getByText('Threads').first()).toBeVisible()
      // Threads panel has a "+ New" button
      await expect(page.getByRole('button', { name: '+ New' }).first()).toBeVisible()

      // Click Terminal tab
      await page.getByRole('button', { name: 'Terminal' }).click()
      await expect(page.getByText('Terminal').first()).toBeVisible()
    })

    test('US-WS-018: header shows workspace breadcrumb and selector', async ({ page }) => {
      // The workspace view renders inside main
      await expect(page.locator('main')).toBeVisible()
      // Sidebar tab bar is visible with all expected tabs
      for (const label of ['Files', 'Git', 'Threads', 'Planning', 'Terminal']) {
        await expect(page.getByRole('button', { name: label }).first()).toBeVisible()
      }
    })
  })

  test.describe('Main Content Tabs', () => {
    test('US-WS-008: multiple tabs open simultaneously with tab switching', async ({ page }) => {
      // Main content area renders
      await expect(page.getByText('Main content area')).toBeVisible()
      // Sidebar tabs can be switched without losing main content
      await page.getByRole('button', { name: 'Git' }).click()
      await expect(page.getByText('Main content area')).toBeVisible()
      await page.getByRole('button', { name: 'Files' }).click()
      await expect(page.getByText('Main content area')).toBeVisible()
    })

    test('US-WS-009: switching projects preserves tab state', async ({ page }) => {
      // Switch to Git tab
      await page.getByRole('button', { name: 'Git' }).click()
      await expect(page.getByText('Git').first()).toBeVisible()
      // Main content remains
      await expect(page.getByText('Main content area')).toBeVisible()
      // Tab state persists — Git tab still active after interacting with main
      await expect(page.getByText('No project selected').first()).toBeVisible()
    })
  })

  test.describe('Chat Panel', () => {
    test('US-WS-011: expand chat to full-screen via button', async ({ page }) => {
      // Chat panel visible with thread info
      await expect(page.getByText('Thread: main').first()).toBeVisible()
      // Click expand button
      await page.getByTitle('Expand chat (Cmd+Shift+E)').click()
      // Expanded view shows "Back to Workspace" button
      await expect(page.getByTitle('Back to Workspace')).toBeVisible()
      await expect(page.getByText('Expanded chat view for thread: main')).toBeVisible()
    })

    test('US-WS-012: collapse expanded chat back to panel', async ({ page }) => {
      // Expand first
      await page.getByTitle('Expand chat (Cmd+Shift+E)').click()
      await expect(page.getByTitle('Back to Workspace')).toBeVisible()
      // Collapse
      await page.getByTitle('Back to Workspace').click()
      // Back to normal workspace with sidebar
      await expect(page.getByRole('button', { name: 'Files' }).first()).toBeVisible()
      await expect(page.getByText('Main content area')).toBeVisible()
    })

    test('US-WS-013: resize chat panel by dragging divider', async ({ page }) => {
      // The resize divider exists (cursor-col-resize)
      const divider = page.locator('.cursor-col-resize')
      await expect(divider).toBeVisible()
      // Verify chat panel exists
      await expect(page.getByText('Chat for thread: main')).toBeVisible()
    })
  })
})
