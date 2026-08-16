// TTS toggle button — floating control that enables/disables TTS output
// for the current thread, independent of input modality. Toggling ON
// from a device routes TTS audio to that device. Toggling OFF silences it.
//
// Only the device whose name matches the active override shows the
// unmuted icon. Other devices show muted (with a hint about which
// device holds playback).

import { ttsActiveHere, ttsEnabled, ttsDeviceName, toggleTtsOverride } from './tts-override-store.js'

export function TtsToggle() {
  const activeHere = () => ttsActiveHere()
  const activeElsewhere = () => ttsEnabled() && !ttsActiveHere()
  const otherDevice = () => ttsDeviceName()

  const title = () => {
    if (activeHere()) return `TTS playing here. Click to mute.`
    if (activeElsewhere()) return `TTS playing on ${otherDevice()}. Click to switch here.`
    return 'Enable TTS for all responses'
  }

  return (
    <button
      class="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full border-none transition-opacity"
      style={{
        opacity: activeHere() ? 1 : 0.4,
        color: activeHere() ? '#fff' : 'var(--c-text)',
        background: activeHere() ? 'var(--c-accent)' : 'transparent'
      }}
      onClick={() => toggleTtsOverride()}
      title={title()}
    >
      {activeHere() ? (
        /* Speaker with sound waves — TTS active on THIS device */
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      ) : (
        /* Speaker muted — TTS inactive or on another device */
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </svg>
      )}
    </button>
  )
}
