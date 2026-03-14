import { For } from 'solid-js'
import { agentName } from '../../lib/identity.js'
import { currentTheme, setTheme } from '../theme/store.js'
import { settingsOpen, setSettingsOpen } from '../nav/store.js'
import type { Theme } from '../theme/themes.js'

// ── Exported helpers (used by tests) ─────────────────────────────────
export const TTS_ENABLED_KEY = 'sovereign:tts-enabled'

export function getTtsEnabled(): boolean {
  return localStorage.getItem(TTS_ENABLED_KEY) !== 'false'
}

export function setTtsEnabled(enabled: boolean): void {
  localStorage.setItem(TTS_ENABLED_KEY, String(enabled))
}

const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: string }> = [
  { value: 'default', label: 'Dark', icon: '🌙' },
  { value: 'light', label: 'Light', icon: '☀️' },
  { value: 'ironman', label: 'Iron Man', icon: '🔵' },
  { value: 'jarvis', label: 'JARVIS', icon: '🟠' }
]

export function SettingsModal() {
  return (
    <div
      class="fixed inset-0 z-[300] flex items-center justify-center"
      classList={{ hidden: !settingsOpen(), flex: settingsOpen() }}
    >
      <div
        class="absolute inset-0"
        style={{ background: 'var(--c-backdrop)', 'backdrop-filter': 'blur(2px)' }}
        onClick={() => setSettingsOpen(false)}
      />

      <div
        class="relative w-[90%] max-w-[400px] overflow-hidden rounded-2xl shadow-xl"
        style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
      >
        <div
          class="flex items-center justify-between px-5 py-4"
          style={{ 'border-bottom': '1px solid var(--c-border)' }}
        >
          <span class="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>
            Settings
          </span>
          <button
            class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border-none text-base transition-all"
            style={{ background: 'var(--c-hover-bg)', color: 'var(--c-text-muted)' }}
            onClick={() => setSettingsOpen(false)}
          >
            ✕
          </button>
        </div>

        <div class="space-y-5 px-5 py-4">
          <div>
            <div class="mb-3 text-xs font-medium tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
              Appearance
            </div>
            <div class="grid grid-cols-3 gap-2">
              <For each={THEME_OPTIONS}>
                {(opt) => (
                  <button
                    class="flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-sm transition-all"
                    style={{
                      background: currentTheme() === opt.value ? 'var(--c-accent)' : 'var(--c-hover-bg)',
                      color: currentTheme() === opt.value ? '#fff' : 'var(--c-text)',
                      'border-color': currentTheme() === opt.value ? 'var(--c-accent)' : 'var(--c-border)'
                    }}
                    onClick={() => setTheme(opt.value)}
                  >
                    <span class="text-lg">{opt.icon}</span>
                    <span class="text-[11px] font-medium">{opt.label}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>

        <div class="px-5 py-3" style={{ 'border-top': '1px solid var(--c-border)' }}>
          <div class="text-center text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
            {agentName()} — Agent Interface
          </div>
        </div>
      </div>
    </div>
  )
}
