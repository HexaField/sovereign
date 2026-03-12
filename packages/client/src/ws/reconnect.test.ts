import { describe, it } from 'vitest'

describe('Reconnector', () => {
  it.todo('starts with initial delay of 1s')
  it.todo('uses exponential backoff on repeated failures')
  it.todo('caps delay at max 30s')
  it.todo('adds jitter to delay')
  it.todo('fires onReconnect handler on successful reconnect')
  it.todo('stop cancels pending reconnection')
  it.todo('resets backoff after successful connection')
})
