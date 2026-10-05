// Which device the Overview's Device card shows — picked by clicking a node
// in the Tailscale card. Keyed by Tailscale IP, the one field both the
// Tailscale peer list and the System device metrics carry. null = this
// machine (the card's own health view).

import { createSignal } from 'solid-js'

export const [selectedDeviceIp, setSelectedDeviceIp] = createSignal<string | null>(null)
