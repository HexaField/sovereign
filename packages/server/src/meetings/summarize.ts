// Summarization pipeline — §8.3

export interface SummarizationResult {
  text: string
  actionItems: unknown[]
  decisions: string[]
  keyTopics: string[]
}

export function createSummarizationPipeline(): void {
  throw new Error('Not implemented')
}
