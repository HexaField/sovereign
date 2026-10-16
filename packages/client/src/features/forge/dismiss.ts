// Close a popover on Escape or on a pointerdown outside it. A full-screen
// backdrop does not work here: the app header sits in its own stacking
// context above the tab, so clicks there never reached the backdrop.

import { onCleanup, onMount } from 'solid-js'

export function useDismiss(isOpen: () => boolean, inside: () => HTMLElement | undefined, close: () => void): void {
  onMount(() => {
    const onDown = (e: PointerEvent): void => {
      if (!isOpen()) return
      const el = inside()
      if (el && e.target instanceof Node && el.contains(e.target)) return
      close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (isOpen() && e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    })
  })
}
