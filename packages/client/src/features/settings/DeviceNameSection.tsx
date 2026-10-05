// Device name field — shown at the top of System → Devices. Commits on
// blur or Enter, and on unmount (switching tabs unmounts the input before
// it blurs).

import { createSignal, onCleanup, type JSX } from 'solid-js'
import { agentName } from '../../lib/identity.js'
import { deviceName, setDeviceName } from './device-name.js'

export function DeviceNameSection(): JSX.Element {
  const [draft, setDraft] = createSignal(deviceName())

  const commit = (): void => {
    setDeviceName(draft())
    setDraft(deviceName())
  }
  onCleanup(() => {
    if (draft() !== deviceName()) commit()
  })

  return (
    <section>
      <h3 class="mb-3 text-xs font-medium tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
        This Device
      </h3>
      <input
        type="text"
        value={draft()}
        placeholder="e.g. Josh Phone"
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        class="w-full max-w-sm rounded-lg px-3 py-2 text-sm outline-none"
        style={{
          background: 'var(--c-bg)',
          border: '1px solid var(--c-border)',
          color: 'var(--c-text)'
        }}
      />
      <div class="mt-2 text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
        Names this device so {agentName()} can tell your devices apart in voice replies.
      </div>
    </section>
  )
}
