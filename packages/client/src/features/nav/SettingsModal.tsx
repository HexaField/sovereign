import { createSignal, For, Show } from 'solid-js'
import type { JSX } from 'solid-js'

export const TTS_ENABLED_KEY = 'sovereign:tts-enabled'

export function getTtsEnabled(): boolean {
  try {
    return localStorage.getItem(TTS_ENABLED_KEY) !== 'false'
  } catch {
    return true
  }
}

export function setTtsEnabled(v: boolean): void {
  localStorage.setItem(TTS_ENABLED_KEY, String(v))
}

const THEMES = ['default', 'light', 'ironman', 'jarvis'] as const

export interface SettingsModalProps {
  open: () => boolean
  onClose: () => void
  theme?: () => string
  setTheme?: (t: string) => void
  children?: JSX.Element
}

export function SettingsModal(props: SettingsModalProps) {
  const [tts, setTts] = createSignal(getTtsEnabled())

  const toggleTts = () => {
    const next = !tts()
    setTts(next)
    setTtsEnabled(next)
  }

  return (
    <Show when={props.open()}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose()
        }}
      >
        <div
          class="flex w-96 flex-col rounded-lg shadow-xl"
          style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
        >
          <div class="flex items-center justify-between border-b p-4" style={{ 'border-color': 'var(--c-border)' }}>
            <h2 class="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>
              Settings
            </h2>
            <button onClick={props.onClose} style={{ color: 'var(--c-text-muted)' }}>
              ✕
            </button>
          </div>

          <div class="space-y-4 p-4">
            <div>
              <h3 class="mb-2 text-xs font-semibold uppercase" style={{ color: 'var(--c-text-muted)' }}>
                Theme
              </h3>
              <div class="flex gap-2">
                <For each={[...THEMES]}>
                  {(theme) => (
                    <button
                      class="rounded px-3 py-1.5 text-sm"
                      style={{
                        background: props.theme?.() === theme ? 'var(--c-accent)' : 'var(--c-bg)',
                        color: props.theme?.() === theme ? 'var(--c-bg)' : 'var(--c-text)',
                        border: '1px solid var(--c-border)'
                      }}
                      onClick={() => props.setTheme?.(theme)}
                    >
                      {theme}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div>
              <h3 class="mb-2 text-xs font-semibold uppercase" style={{ color: 'var(--c-text-muted)' }}>
                Audio
              </h3>
              <label class="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={tts()} onChange={toggleTts} />
                <span class="text-sm" style={{ color: 'var(--c-text)' }}>
                  Enable TTS
                </span>
              </label>
            </div>

            {props.children}
          </div>
        </div>
      </div>
    </Show>
  )
}
