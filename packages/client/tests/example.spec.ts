import { expect, test } from '@playwright/test'

test('has title', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/Solid App/)
})

test('shows server message', async ({ page }) => {
  await page.route('https://localhost:3001/health', async (route) => {
    const json = { message: 'template', status: 'ok' }
    await route.fulfill({ json })
  })
  await page.goto('/')
  await expect(page.getByText('Client')).toBeVisible()
  // Wait for fetch
  await expect(page.getByText('Shared: template')).toBeVisible()
  await expect(page.getByText('Server: template ok')).toBeVisible()
})
