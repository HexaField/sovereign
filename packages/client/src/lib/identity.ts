// Identity store — fetches agent name and icon from server config
// Defaults shown immediately; server values override on load

import { createSignal } from 'solid-js'

const [agentName, setAgentName] = createSignal('Sovereign')
const [agentIcon, setAgentIcon] = createSignal('⬡')
const [loaded, setLoaded] = createSignal(false)

export { agentName, agentIcon, loaded as identityLoaded }

export async function loadIdentity(): Promise<void> {
  try {
    const res = await fetch('/api/system/identity')
    if (res.ok) {
      const data = await res.json()
      if (data.agentName) setAgentName(data.agentName)
      if (data.agentIcon) setAgentIcon(data.agentIcon)
    }
  } catch {
    // keep defaults
  }
  setLoaded(true)
}
