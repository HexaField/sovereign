// ── PCA via power iteration ─────────────────────────────────────────
// Computes the top-k principal components of a set of embedding vectors.
// Uses power iteration with deflation — no external linear algebra deps.

/** Compute the mean vector of a row-major embedding matrix. */
function computeMean(vectors: number[][], dim: number): number[] {
  const mean = new Float64Array(dim)
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) mean[i] += v[i]
  }
  const n = vectors.length
  for (let i = 0; i < dim; i++) mean[i] /= n
  return Array.from(mean)
}

/** Subtract the mean from each vector in place. */
function centerInPlace(vectors: number[][], mean: number[]): void {
  for (const v of vectors) {
    for (let i = 0; i < mean.length; i++) v[i] -= mean[i]
  }
}

/**
 * Extract a single principal component via power iteration.
 * Returns the normalised eigenvector.
 */
function powerIteration(centered: number[][], dim: number, maxIter = 200, tol = 1e-8): number[] {
  // Random-ish initial vector (seeded from dimension index for reproducibility)
  let vec = Array.from({ length: dim }, (_, i) => Math.sin(i * 1.618 + 0.5))
  let norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
  vec = vec.map((v) => v / norm)

  for (let iter = 0; iter < maxIter; iter++) {
    // Multiply: result = (X^T X) vec  — done as X^T (X vec) to avoid forming the covariance matrix
    const xv = centered.map((row) => row.reduce((s, r, i) => s + r * vec[i], 0))
    const result = new Float64Array(dim)
    for (let i = 0; i < centered.length; i++) {
      const row = centered[i]
      const w = xv[i]
      for (let j = 0; j < dim; j++) result[j] += row[j] * w
    }

    norm = Math.sqrt(result.reduce((s, v) => s + v * v, 0))
    if (norm < 1e-15) break

    const next = Array.from(result).map((v) => v / norm)
    const delta = next.reduce((s, v, i) => s + (v - vec[i]) ** 2, 0)
    vec = next
    if (delta < tol) break
  }
  return vec
}

/** Deflate: remove the component along `basis` from every vector. */
function deflate(centered: number[][], basis: number[]): void {
  for (const v of centered) {
    const dot = v.reduce((s, val, i) => s + val * basis[i], 0)
    for (let i = 0; i < basis.length; i++) v[i] -= dot * basis[i]
  }
}

export interface PcaResult {
  /** k basis vectors (row-major, each length = embeddingDim) */
  basis: number[][]
  /** Mean vector used for centering (length = embeddingDim) */
  mean: number[]
}

/**
 * Compute the top-k principal components of the given embedding vectors.
 * Returns the basis matrix (k × dim, row-major) and the centering mean.
 */
export function computePca(vectors: number[][], k: number): PcaResult {
  if (vectors.length === 0) return { basis: [], mean: [] }

  const dim = vectors[0].length
  const safeK = Math.min(k, dim, vectors.length)
  const mean = computeMean(vectors, dim)

  // Deep-copy so centering + deflation don't mutate the caller's data
  const centered = vectors.map((v) => [...v])
  centerInPlace(centered, mean)

  const basis: number[][] = []
  for (let c = 0; c < safeK; c++) {
    const component = powerIteration(centered, dim)
    basis.push(component)
    deflate(centered, component)
  }

  return { basis, mean }
}
