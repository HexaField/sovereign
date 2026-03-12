// Local JSON cache + offline queue for issues

export interface IssueCache {
  get(key: string): unknown | undefined
  set(key: string, value: unknown): void
  isStale(key: string): boolean
  clear(): void
  enqueue(op: unknown): void
  flushQueue(): Promise<{ replayed: number; failed: number }>
}

export function createIssueCache(_dataDir: string): IssueCache {
  throw new Error('not implemented')
}
