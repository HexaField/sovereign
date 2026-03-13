import { createSignal } from 'solid-js'

export type VoiceState = 'idle' | 'listening' | 'speaking' | 'processing'

export const [voiceState, _setVoiceState] = createSignal<VoiceState>('idle')
export const [isRecording, _setIsRecording] = createSignal(false)
export const [recordingTimerText, _setRecordingTimerText] = createSignal('00:00')
export const [voiceStatusText, _setVoiceStatusText] = createSignal('Tap to speak')

export function startRecording(): void {
  throw new Error('not implemented')
}

export function stopRecording(): void {
  throw new Error('not implemented')
}

export function interruptPlayback(): void {
  throw new Error('not implemented')
}
