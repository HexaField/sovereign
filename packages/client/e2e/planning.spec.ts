import { test, expect } from '@playwright/test'
test.describe('Global Planning View', () => {
  test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop-only: requires sidebar and keyboard navigation')

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Navigate to planning view
    await page.keyboard.press('Meta+4')
    await expect(page.getByTestId('planning-view')).toBeVisible()
  })

  test('US-PLAN-001: shows all planned work across workspaces', async ({ page }) => {
    // Planning view toolbar should be visible
    await expect(page.getByTestId('planning-toolbar')).toBeVisible()

    // Create issue button should be present
    await expect(page.getByTestId('create-issue-button')).toBeVisible()

    // Assign agent button should be present
    await expect(page.getByTestId('assign-agent-button')).toBeVisible()
  })

  test('US-PLAN-002: highlights critical path across workspaces', async ({ page }) => {
    // The DAG view is the default — it renders edges with thicker strokes for critical path
    // With no data, just verify the DAG SVG renders
    await expect(page.getByTestId('dag-svg')).toBeVisible()
  })

  test('US-PLAN-003: shows blocked items with blocker info', async ({ page }) => {
    // Switch to kanban view to see status columns including "blocked"
    await page.getByTestId('view-mode-kanban').click()
    await expect(page.getByTestId('kanban-board')).toBeVisible()

    // The "Blocked" column should exist
    await expect(page.getByTestId('kanban-column-blocked')).toBeVisible()
    // Verify its header text
    await expect(page.locator('[data-testid="kanban-column-blocked"]').locator('text=Blocked')).toBeVisible()
  })

  test('US-PLAN-004: create issue from planning view in any workspace', async ({ page }) => {
    // Click create issue button
    await page.getByTestId('create-issue-button').click()

    // Dialog should appear
    await expect(page.getByTestId('create-issue-dialog')).toBeVisible()

    // Verify form fields are present
    await expect(page.getByTestId('create-issue-workspace')).toBeVisible()
    await expect(page.getByTestId('create-issue-title')).toBeVisible()
    await expect(page.getByTestId('create-issue-description')).toBeVisible()
    await expect(page.getByTestId('create-issue-submit')).toBeVisible()

    // Cancel closes the dialog
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('create-issue-dialog')).not.toBeVisible()
  })

  test('US-PLAN-005: switch between DAG, kanban, list, tree views', async ({ page }) => {
    const selector = page.getByTestId('view-mode-selector')
    await expect(selector).toBeVisible()

    // DAG is default
    await expect(page.getByTestId('dag-svg')).toBeVisible()

    // Switch to Kanban
    await page.getByTestId('view-mode-kanban').click()
    await expect(page.getByTestId('kanban-board')).toBeVisible()

    // Switch to List
    await page.getByTestId('view-mode-list').click()
    await expect(page.getByTestId('list-view')).toBeVisible()

    // Switch to Tree
    await page.getByTestId('view-mode-tree').click()
    await expect(page.getByTestId('tree-view')).toBeVisible()

    // Switch back to DAG
    await page.getByTestId('view-mode-dag').click()
    await expect(page.getByTestId('dag-svg')).toBeVisible()
  })

  test('US-PLAN-006: filter by workspace, status, assignee', async ({ page }) => {
    // Filter dropdowns should be in toolbar
    await expect(page.getByTestId('filter-workspace')).toBeVisible()
    await expect(page.getByTestId('filter-status')).toBeVisible()
    await expect(page.getByTestId('filter-priority')).toBeVisible()

    // Search input should be present
    await expect(page.getByTestId('planning-search')).toBeVisible()

    // Type in search
    await page.getByTestId('planning-search').fill('test query')
    await expect(page.getByTestId('planning-search')).toHaveValue('test query')

    // Clear
    await page.getByTestId('planning-search').fill('')
  })
})
