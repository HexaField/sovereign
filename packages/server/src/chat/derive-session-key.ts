// Pure function extracted from createChatModule for testability
export function deriveSessionKey(threadKey: string): string {
  if (!threadKey) return ''
  // Already a full session key — don't double-prefix
  if (threadKey.startsWith('agent:')) return threadKey
  if (threadKey === 'main') return 'agent:main:main'
  return `agent:main:thread:${threadKey}`
}
