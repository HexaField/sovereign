// Local JSON cache for reviews

export interface ReviewCache {
  get(key: string): unknown | undefined
  set(key: string, value: unknown): void
  isStale(key: string): boolean
  clear(): void
}

export function createReviewCache(_dataDir: string): ReviewCache {
  throw new Error('not implemented')
}
