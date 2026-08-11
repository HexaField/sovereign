// ── Local embedding via @huggingface/transformers ───────────────────
// Wraps the Xenova/all-MiniLM-L6-v2 model (384-dim vectors, ~22 MB).
// The pipeline loads lazily on first call and stays cached in memory.

let pipeline: any = null
let loading: Promise<any> | null = null

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

async function ensurePipeline(): Promise<any> {
  if (pipeline) return pipeline
  if (loading) return loading
  loading = (async () => {
    const { pipeline: createPipeline } = await import('@huggingface/transformers')
    pipeline = await createPipeline('feature-extraction', MODEL_ID, {
      dtype: 'fp32'
    })
    return pipeline
  })()
  return loading
}

/**
 * Embed a batch of texts into 384-dim vectors.
 * Returns one number[] per input string.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const pipe = await ensurePipeline()
  const results: number[][] = []

  // Process in batches to avoid OOM on large inputs
  const BATCH = 64
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
    const output = await pipe(batch, { pooling: 'mean', normalize: true })
    const data = output.tolist() as number[][]
    results.push(...data)
  }

  return results
}

/** Returns the embedding dimensionality for the loaded model. */
export function embeddingDim(): number {
  return 384
}
