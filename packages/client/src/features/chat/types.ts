import type { ParsedTurn, WorkItem, AgentStatus } from '@template/core'

export interface ChatMessage {
  turn: ParsedTurn
  pending?: boolean
}
