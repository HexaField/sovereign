import type { ParsedTurn } from '@template/core'

export interface ChatMessage {
  turn: ParsedTurn
  pending?: boolean
}
