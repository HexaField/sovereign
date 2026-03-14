// Voice acknowledgment — §8.5.2.2

const VERB_PATTERNS: Array<{ pattern: RegExp; template: (match: RegExpMatchArray) => string }> = [
  // "can you check X" / "could you check X" / "please check X"
  {
    pattern: /(?:can|could|would)\s+you\s+(\w+)\s+(.+?)(?:\?|$)/i,
    template: (m) => `${capitalize(gerund(m[1]))} ${m[2].trim()} now`
  },
  // "please X Y"
  { pattern: /please\s+(\w+)\s+(.+?)(?:\?|$)/i, template: (m) => `${capitalize(gerund(m[1]))} ${m[2].trim()} now` },
  // "check/look at/run/fix/show/find/get/read/update/deploy/build X"
  {
    pattern:
      /^(check|look at|run|fix|show|find|get|read|update|deploy|build|restart|test|review|open|close|delete|create|search|fetch|pull|push|send|install|start|stop)\s+(.+?)(?:\?|$)/i,
    template: (m) => `${capitalize(gerund(m[1]))} ${m[2].trim()} now`
  },
  // "what is/are X" → "Looking into X now"
  { pattern: /^what(?:'s|\s+is|\s+are)\s+(.+?)(?:\?|$)/i, template: (m) => `Looking into ${m[1].trim()} now` },
  // "how do I X" → "Looking into how to X now"
  {
    pattern: /^how\s+(?:do|can|should)\s+I\s+(.+?)(?:\?|$)/i,
    template: (m) => `Looking into how to ${m[1].trim()} now`
  },
  // "why is/did X" → "Looking into why X"
  { pattern: /^why\s+(?:is|did|does|are|was)\s+(.+?)(?:\?|$)/i, template: (m) => `Looking into why ${m[1].trim()} now` }
]

const IRREGULAR_GERUNDS: Record<string, string> = {
  run: 'Running',
  get: 'Getting',
  set: 'Setting',
  put: 'Putting',
  stop: 'Stopping',
  begin: 'Beginning',
  fix: 'Fixing',
  mix: 'Mixing',
  box: 'Boxing'
}

function gerund(verb: string): string {
  const lower = verb.toLowerCase()
  if (IRREGULAR_GERUNDS[lower]) return IRREGULAR_GERUNDS[lower].toLowerCase()
  if (lower.endsWith('e') && !lower.endsWith('ee')) return lower.slice(0, -1) + 'ing'
  if (/^[a-z]+[bcdfghjklmnpqrstvwxyz]$/.test(lower) && lower.length <= 5) {
    // CVC doubling for short words
    const vowels = 'aeiou'
    if (lower.length >= 3 && vowels.includes(lower[lower.length - 2]) && !vowels.includes(lower[lower.length - 1])) {
      return lower + lower[lower.length - 1] + 'ing'
    }
  }
  return lower + 'ing'
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const FALLBACK = 'Let me work on that'

export interface AcknowledgmentGenerator {
  generate(userMessage: string): string
}

export function createAcknowledgmentGenerator(): AcknowledgmentGenerator {
  return {
    generate(userMessage: string): string {
      const trimmed = userMessage.trim()
      if (!trimmed) return FALLBACK

      for (const { pattern, template } of VERB_PATTERNS) {
        const match = trimmed.match(pattern)
        if (match) {
          const result = template(match)
          // Clean up trailing punctuation duplication
          return result.replace(/\s+now$/, ' now').replace(/\.+$/, '')
        }
      }

      return FALLBACK
    }
  }
}
