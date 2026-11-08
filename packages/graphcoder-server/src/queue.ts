/** Runs jobs one at a time, in the order they arrive; a failed job never stops the ones behind it */
export interface SerialQueue {
  run<T>(job: () => Promise<T>): Promise<T>
}

export function createSerialQueue(): SerialQueue {
  let chain: Promise<unknown> = Promise.resolve()
  return {
    run(job) {
      const next = chain.then(job)
      chain = next.catch(() => undefined)
      return next
    }
  }
}
