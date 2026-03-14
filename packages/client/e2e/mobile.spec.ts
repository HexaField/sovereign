import { test, expect } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 } }) // iPhone 14

test.describe('Mobile / Responsive', () => {
  test('US-MOB-001: swipe between workspace panels', async () => {
    test.skip()
  })
  test('US-MOB-002: only one panel visible at a time filling viewport', async () => {
    test.skip()
  })
  test('US-MOB-003: tapping file auto-switches to file viewer', async () => {
    test.skip()
  })
  test('US-MOB-004: tapping thread auto-switches to chat', async () => {
    test.skip()
  })
  test('US-MOB-005: touch pan and zoom on canvas', async () => {
    test.skip()
  })
})
