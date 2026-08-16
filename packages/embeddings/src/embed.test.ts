import { describe, it, expect } from 'vitest'
import { embedText, embedBatch, embedHealthCheck } from './embed.js'

// These tests hit the live local embedding server on :9092.
// Skip if the server isn't running.
const SERVER_URL = 'http://127.0.0.1:9092'

describe('embed (live server)', async () => {
  const healthy = await embedHealthCheck(SERVER_URL)

  it.skipIf(!healthy)('health check passes', async () => {
    const ok = await embedHealthCheck(SERVER_URL)
    expect(ok).toBe(true)
  })

  it.skipIf(!healthy)('embeds a single text', async () => {
    const result = await embedText('The quick brown fox', 'search_document', {
      baseUrl: SERVER_URL
    })
    expect(result.dimensions).toBe(768)
    expect(result.embedding).toHaveLength(768)
    // Verify non-zero
    expect(result.embedding.some((v) => v !== 0)).toBe(true)
  })

  it.skipIf(!healthy)('embeds a batch', async () => {
    const results = await embedBatch(['First sentence', 'Second sentence', 'Third sentence'], 'search_document', {
      baseUrl: SERVER_URL
    })
    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r.dimensions).toBe(768)
    }
  })

  it.skipIf(!healthy)('query and document prefixes produce different vectors', async () => {
    const text = 'Neural network architecture'
    const docEmb = await embedText(text, 'search_document', { baseUrl: SERVER_URL })
    const queryEmb = await embedText(text, 'search_query', { baseUrl: SERVER_URL })

    // Same text, different prefixes — vectors should differ
    const diff = docEmb.embedding.reduce((sum, v, i) => sum + Math.abs(v - queryEmb.embedding[i]), 0)
    expect(diff).toBeGreaterThan(0)
  })

  it('returns false for unreachable server', async () => {
    const ok = await embedHealthCheck('http://127.0.0.1:19999')
    expect(ok).toBe(false)
  })
})
