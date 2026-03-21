import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/server/src/**/*.test.ts', 'packages/client/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**', '**/tests/**']
  }
})
