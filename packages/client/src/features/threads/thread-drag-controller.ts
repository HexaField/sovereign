// Drag to reorder a thread list: pointer handling. Pointer events, so a mouse,
// a pen and a finger all work.
//
// - The ⠿ grip starts a drag with any pointer. It has `touch-action: none`, so
//   on a phone a finger on the grip drags instead of scrolling the list.
// - A mouse can also drag the row itself once it moves a few pixels; a plain
//   click (no movement) still opens the thread. Touch on the row keeps
//   scrolling, and a long-press keeps opening the ⋯ menu.
// - Buttons, links' own controls and text fields in a row never start a drag.
// - Near the list's top or bottom edge the list scrolls; Escape cancels.
//
// Rows are the elements carrying `data-thread-row="<id>"` inside `container`,
// in the same order as `items()`.

import { createSignal } from 'solid-js'
import { autoScrollStep, dropIndexAt, planDrop, type DragThread, type ReorderPlan } from './thread-drag.js'

/** Where a drag would drop now. `pinned` is set when the drop pins (true) or unpins (false). */
export interface DropTarget {
  index: number
  pinned?: boolean
}

export interface ThreadDragOptions<T extends DragThread> {
  /** The threads in the order the list shows them. */
  items: () => readonly T[]
  /** The list element holding the rows; also the element that scrolls. */
  container: () => HTMLElement | undefined
  /** Apply a drop. */
  onReorder: (plan: ReorderPlan) => void
}

/** Movement (px) before a pressed row or grip turns into a drag. */
const MOUSE_THRESHOLD = 5
const GRIP_THRESHOLD = 3

/** Elements inside a row that keep their own pointer behaviour. */
const OWN_POINTER = 'button, input, textarea, select, [contenteditable="true"], [data-no-drag]'

export function createThreadDrag<T extends DragThread>(opts: ThreadDragOptions<T>) {
  const [draggingId, setDraggingId] = createSignal<string | null>(null)
  const [target, setTarget] = createSignal<DropTarget | null>(null)

  let press: { id: string; pointerId: number; x: number; y: number; threshold: number } | null = null
  let lastY = 0
  let frame = 0
  let bodyUserSelect = ''

  function rows(): HTMLElement[] {
    const el = opts.container()
    return el ? Array.from(el.querySelectorAll<HTMLElement>('[data-thread-row]')) : []
  }

  function retarget(): void {
    const id = draggingId()
    if (!id) return
    const index = dropIndexAt(
      rows().map((r) => r.getBoundingClientRect()),
      lastY
    )
    const plan = planDrop(opts.items(), id, index)
    // No line where a drop would change nothing.
    setTarget(plan ? { index, ...(plan.pinned !== undefined ? { pinned: plan.pinned } : {}) } : null)
  }

  function tick(): void {
    frame = 0
    const el = opts.container()
    if (!draggingId() || !el) return
    const step = autoScrollStep(el.getBoundingClientRect(), lastY)
    if (step) {
      const before = el.scrollTop
      el.scrollTop += step
      if (el.scrollTop !== before) retarget()
    }
    frame = requestAnimationFrame(tick)
  }

  function begin(id: string, y: number): void {
    setDraggingId(id)
    lastY = y
    bodyUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    document.getSelection()?.removeAllRanges()
    retarget()
    frame = requestAnimationFrame(tick)
  }

  function end(drop: boolean): void {
    const id = draggingId()
    const t = target()
    if (!id) return
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    setDraggingId(null)
    setTarget(null)
    document.body.style.userSelect = bodyUserSelect
    // The click that ends a mouse drag must not also open the row.
    swallowNextClick()
    if (!drop || !t) return
    const plan = planDrop(opts.items(), id, t.index)
    if (plan) opts.onReorder(plan)
  }

  function onMove(e: PointerEvent): void {
    if (!press || e.pointerId !== press.pointerId) return
    lastY = e.clientY
    if (!draggingId()) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < press.threshold) return
      begin(press.id, e.clientY)
    }
    e.preventDefault()
    retarget()
  }

  function onUp(e: PointerEvent): void {
    if (!press || e.pointerId !== press.pointerId) return
    release()
    end(true)
  }

  function onCancel(e: PointerEvent): void {
    if (!press || e.pointerId !== press.pointerId) return
    release()
    end(false)
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !draggingId()) return
    e.preventDefault()
    e.stopPropagation()
    release()
    end(false)
  }

  function listen(): void {
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
  }

  function release(): void {
    press = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
  }

  function swallowNextClick(): void {
    const swallow = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
  }

  function startPress(e: PointerEvent, id: string, threshold: number): void {
    if (press || draggingId()) return
    press = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, threshold }
    lastY = e.clientY
    listen()
  }

  return {
    /** The id of the thread being dragged, or null. */
    draggingId,
    /** Where it would drop now, or null (no drag, or a drop that changes nothing). */
    target,
    /** True when the drop line belongs above row `index` (0..n; n: below the last). */
    lineAt: (index: number) => target()?.index === index,
    /** pointerdown on a row's ⠿ grip: any pointer drags. */
    onGripPointerDown(e: PointerEvent, id: string): void {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      startPress(e, id, GRIP_THRESHOLD)
    },
    /** pointerdown on a row: a mouse drags once it moves; touch and pen scroll as before. */
    onRowPointerDown(e: PointerEvent, id: string): void {
      if (e.pointerType !== 'mouse' || e.button !== 0) return
      if ((e.target as Element | null)?.closest?.(OWN_POINTER)) return
      startPress(e, id, MOUSE_THRESHOLD)
    },
    /** Stop listening (component cleanup). */
    dispose(): void {
      release()
      if (draggingId()) end(false)
    }
  }
}

export type ThreadDrag = ReturnType<typeof createThreadDrag>
