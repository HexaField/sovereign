// §2.4 VoiceWidget — Voice interaction widget for dashboard
// Pure functions exported for testability; SolidJS component uses Tailwind + var(--c-*) tokens

import { voiceState, voiceStatusText, startRecording, stopRecording } from '../voice/store'
import { createSignal } from 'solid-js'

export type VoiceWidgetState = 'idle' | 'listening' | 'processing'

export function mapVoiceState(state: string): VoiceWidgetState {
  if (state === 'listening') return 'listening'
  if (state === 'processing') return 'processing'
  return 'idle'
}

export function getMicButtonColor(state: VoiceWidgetState): string {
  switch (state) {
    case 'listening':
      return 'bg-red-500'
    case 'processing':
      return 'bg-amber-500'
    case 'idle':
      return 'bg-green-500'
  }
}

export function getMicButtonLabel(state: VoiceWidgetState): string {
  switch (state) {
    case 'listening':
      return 'Stop'
    case 'processing':
      return 'Processing…'
    case 'idle':
      return 'Tap to speak'
  }
}

export const [lastTranscript, setLastTranscript] = createSignal('')
export const [lastResponse, setLastResponse] = createSignal('')

export async function handleVoiceToggle(): Promise<void> {
  const state = voiceState()
  if (state === 'listening') {
    const text = await stopRecording()
    if (text) setLastTranscript(text)
  } else if (state === 'idle') {
    setLastTranscript('')
    setLastResponse('')
    await startRecording()
  }
}

export default function VoiceWidget() {
  const widgetState = () => mapVoiceState(voiceState())

  return (
    <div
      class="flex flex-col items-center gap-3 rounded-lg border p-4"
      style={{
        background: 'var(--c-bg-raised)',
        'border-color': 'var(--c-border)',
        'border-radius': '8px'
      }}
    >
      <button
        class={`flex h-16 w-16 items-center justify-center rounded-full text-2xl text-white transition-colors ${getMicButtonColor(widgetState())}`}
        onClick={handleVoiceToggle}
        disabled={widgetState() === 'processing'}
      >
        🎤
      </button>
      <p class="text-xs opacity-70" style={{ color: 'var(--c-text)' }}>
        {voiceStatusText()}
      </p>
      {lastTranscript() && (
        <div class="w-full rounded p-2 text-xs" style={{ background: 'var(--c-bg)', color: 'var(--c-text)' }}>
          <span class="font-medium">You:</span> {lastTranscript()}
        </div>
      )}
      {lastResponse() && (
        <div class="w-full rounded p-2 text-xs" style={{ background: 'var(--c-bg)', color: 'var(--c-text)' }}>
          <span class="font-medium">Agent:</span> {lastResponse()}
        </div>
      )}
    </div>
  )
}
