// Quick settings — appearance (theme) and notifications. Shown in the
// header's status popover. The device name lives in System → Devices.

import { For, type JSX } from 'solid-js'
import { currentTheme, setTheme } from '../theme/store.js'
import { MoonIcon, SunIcon, CircleDotIcon } from '../../ui/icons.js'
import type { Theme } from '../theme/themes.js'
import { pushPermission, pushSubscribed, enablePush, disablePush } from '../../lib/push.js'

const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: () => JSX.Element }> = [
  { value: 'default', label: 'Dark', icon: () => <MoonIcon class="h-5 w-5" /> },
  { value: 'light', label: 'Light', icon: () => <SunIcon class="h-5 w-5" /> },
  { value: 'ironman', label: 'Iron Man', icon: () => <CircleDotIcon class="h-5 w-5" /> },
  { value: 'jarvis', label: 'JARVIS', icon: () => <CircleDotIcon class="h-5 w-5" /> }
]

export default function SettingsContent() {
  return (
    <div>
      <div class="space-y-5">
        {/* Appearance */}
        <section>
          <h3 class="mb-3 text-xs font-medium tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
            Appearance
          </h3>
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
                  <span class="flex items-center text-lg">{opt.icon()}</span>
                  <span class="text-[11px] font-medium">{opt.label}</span>
                </button>
              )}
            </For>
          </div>
        </section>

        {/* Notifications */}
        <NotificationsSection />
      </div>
    </div>
  )
}

function NotificationsSection(): JSX.Element {
  const handleToggle = async () => {
    if (pushSubscribed()) {
      await disablePush()
    } else {
      const result = await enablePush()
      if (!result.ok && result.reason === 'denied') {
        console.warn('[push] notification permission denied')
      }
    }
  }

  const buttonLabel = () => {
    if (pushPermission() === 'unsupported') return 'Not supported on this device'
    if (pushPermission() === 'denied') return 'Blocked — change in browser settings'
    if (pushSubscribed()) return 'Disable browser notifications'
    return 'Enable browser notifications'
  }

  const buttonDisabled = () => pushPermission() === 'unsupported' || pushPermission() === 'denied'

  return (
    <section>
      <h3 class="mb-3 text-xs font-medium tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
        Notifications
      </h3>
      <button
        type="button"
        class="w-full cursor-pointer rounded-lg border px-3 py-2 text-sm font-medium transition-all"
        style={{
          background: pushSubscribed() ? 'var(--c-accent)' : 'var(--c-hover-bg)',
          color: pushSubscribed() ? '#fff' : 'var(--c-text)',
          'border-color': pushSubscribed() ? 'var(--c-accent)' : 'var(--c-border)',
          opacity: buttonDisabled() ? '0.5' : '1',
          cursor: buttonDisabled() ? 'not-allowed' : 'pointer'
        }}
        disabled={buttonDisabled()}
        onClick={handleToggle}
      >
        {buttonLabel()}
      </button>
      <div class="mt-2 text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
        Per-thread mute lives in the thread's ⚙ menu.
      </div>
    </section>
  )
}
