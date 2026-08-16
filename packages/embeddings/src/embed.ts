/**
 * Local embedding client — calls the llama-server /v1/embeddings endpoint.
 * Runs entirely on-machine; no data leaves the box.
 *
 * nomic-embed-text-v1.5 expects prefixed input:
 *   "search_document: <text>"  for indexing
 *   "search_query: <text>"     for queries
 */

export interface EmbedOptions {
  /** Embedding server base URL. Default: http://127.0.0.1:9092 */
  baseUrl?: string
  /** Max retries on transient failure. Default: 2 */
  retries?: number
}

export interface EmbedResult {
  embedding: number[]
  dimensions: number
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:9092'

export async function embedText(
  text: string,
  prefix: 'search_document' | 'search_query',
  opts: EmbedOptions = {}
): Promise<EmbedResult> {
  const results = await embedBatch([text], prefix, opts)
  return results[0]
}

export async function embedBatch(
  texts: string[],
  prefix: 'search_document' | 'search_query',
  opts: EmbedOptions = {}
): Promise<EmbedResult[]> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const retries = opts.retries ?? 2

  const prefixed = texts.map((t) => `${prefix}: ${t}`)

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic', input: prefixed }),
        signal: AbortSignal.timeout(30_000)
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`Embedding server returned ${resp.status}: ${body}`)
      }
      const data = (await resp.json()) as {
        data: Array<{ embedding: number[]; index: number }>
      }
      // Sort by index to preserve input order
      const sorted = data.data.sort((a, b) => a.index - b.index)
      return sorted.map((d) => ({
        embedding: d.embedding,
        dimensions: d.embedding.length
      }))
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      }
    }
  }
  throw lastError ?? new Error('Embedding failed')
}

/** Health check — verify the embedding server responds. */
export async function embedHealthCheck(baseUrl = DEFAULT_BASE_URL): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) return false
    const data = (await resp.json()) as { status?: string }
    return data.status === 'ok'
  } catch {
    return false
  }
}
