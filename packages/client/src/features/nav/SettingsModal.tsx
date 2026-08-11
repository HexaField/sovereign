// Settings helpers — the modal UI moved to features/agent/SettingsContent.tsx.
// These TTS helpers remain here so existing tests keep their import path.

export const TTS_ENABLED_KEY = 'sovereign:tts-enabled'

export function getTtsEnabled(): boolean {
  return localStorage.getItem(TTS_ENABLED_KEY) !== 'false'
}

export function setTtsEnabled(enabled: boolean): void {
  localStorage.setItem(TTS_ENABLED_KEY, String(enabled))
}
