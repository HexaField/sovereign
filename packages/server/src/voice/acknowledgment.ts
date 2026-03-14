// Voice acknowledgment — §8.5.2.2

export function createAcknowledgmentGenerator(): {
  generate(userMessage: string): string
} {
  throw new Error('Not implemented')
}
