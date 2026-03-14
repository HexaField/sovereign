// Voice post-processor — §8.5.2.1

export interface VoicePostProcessor {
  process(agentResponse: string, context?: { threadKey?: string; lastUserMessage?: string }): Promise<string>
}

export function createRuleBasedPostProcessor(): VoicePostProcessor {
  throw new Error('Not implemented')
}
