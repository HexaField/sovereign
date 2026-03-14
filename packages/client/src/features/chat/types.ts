import type { ParsedTurn } from '@sovereign/core'

export interface ChatMessage {
  turn: ParsedTurn
  pending?: boolean
}
