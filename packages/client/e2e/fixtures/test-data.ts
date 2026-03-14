/** Shared test data constants for E2E tests */

export const TEST_ORG = {
  id: 'test-org',
  name: 'Test Workspace'
}

export const TEST_THREAD = {
  key: 'test-thread',
  title: 'Test Thread'
}

export const TEST_MEETING = {
  title: 'Test Meeting',
  duration: 300000 // 5 minutes
}

export const TEST_RECORDING = {
  name: 'test-recording.webm',
  mimeType: 'audio/webm'
}

export const VIEWS = {
  dashboard: '/',
  workspace: '/workspace',
  canvas: '/canvas',
  planning: '/planning',
  system: '/system'
} as const
