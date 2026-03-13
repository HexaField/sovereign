// Voice Module — Transcription + TTS proxy

import type { EventBus } from '@template/core'
import type { VoiceConfig } from '../agent-backend/types.js'

export function createVoiceModule(
  _bus: EventBus,
  _config: VoiceConfig
): { status(): { module: string; status: string } } {
  throw new Error('not implemented')
}
