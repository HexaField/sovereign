import { test, expect } from '@playwright/test'

test.describe('Workspace View — Layout & Core', () => {
  test.describe('Sidebar', () => {
    test('US-WS-001: shows projects in sidebar with git status indicators', async () => {
      test.skip()
    })
    test('US-WS-017: switching sidebar tabs shows one panel at a time', async () => {
      test.skip()
    })
    test('US-WS-018: header shows workspace breadcrumb and selector', async () => {
      test.skip()
    })
  })

  test.describe('Main Content Tabs', () => {
    test('US-WS-008: multiple tabs open simultaneously with tab switching', async () => {
      test.skip()
    })
    test('US-WS-009: switching projects preserves tab state', async () => {
      test.skip()
    })
  })

  test.describe('Chat Panel', () => {
    test('US-WS-011: expand chat to full-screen via button', async () => {
      test.skip()
    })
    test('US-WS-012: collapse expanded chat back to panel', async () => {
      test.skip()
    })
    test('US-WS-013: resize chat panel by dragging divider', async () => {
      test.skip()
    })
  })
})
