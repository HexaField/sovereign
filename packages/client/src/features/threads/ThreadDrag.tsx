// Drag to reorder: the ⠿ grip and the drop line, shared by the header thread
// picker and the Overview list. Behaviour: thread-drag-controller.ts.
//
//   <div class="group relative" data-thread-row={t.id} onPointerDown={(e) => drag.onRowPointerDown(e, t.id)}>
//     <DragGrip drag={drag} threadId={t.id} />
//     …
//     <DropLine show={drag.lineAt(i())} pinned={drag.target()?.pinned} />
//   </div>

import { Show } from 'solid-js'
import type { ThreadDrag } from './thread-drag-controller.js'

/**
 * The ⠿ handle. Shown on hover with a mouse, always on touch screens (no hover)
 * and while its row is dragged. `touch-action: none`: a finger on it drags.
 */
export function DragGrip(props: { drag: ThreadDrag; threadId: string; class?: string }) {
  return (
    <span
      data-drag-grip
      role="presentation"
      title="Drag to reorder"
      class={`flex shrink-0 cursor-grab items-center justify-center self-stretch text-[13px] leading-none opacity-0 transition-opacity select-none group-hover:opacity-60 hover:!opacity-100 active:cursor-grabbing [@media(hover:none)]:opacity-50 ${props.class ?? 'w-4'}`}
      classList={{ '!opacity-100': props.drag.draggingId() === props.threadId }}
      style={{ color: 'var(--c-text-muted)', 'touch-action': 'none', '-webkit-touch-callout': 'none' }}
      onPointerDown={(e) => props.drag.onGripPointerDown(e, props.threadId)}
      // A tap on the grip is not a click on the row.
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      ⠿
    </span>
  )
}

/**
 * Where the dragged thread will land: a line across the top of its row (or the
 * bottom, `at="bottom"`, for a drop below the last row). A drop that pins or
 * unpins the thread says so on the line.
 */
export function DropLine(props: { show: boolean; pinned?: boolean; at?: 'top' | 'bottom' }) {
  // Drawn inside the row (and its label on the row's side of the line), so a
  // scrolling list never clips it at its first or last row.
  const side = () => (props.at === 'bottom' ? 'bottom' : 'top')
  return (
    <Show when={props.show}>
      <div
        data-drop-line
        class="pointer-events-none absolute right-1 left-1 z-10"
        style={{ [side()]: '0', height: '2px', background: 'var(--c-accent)' }}
      >
        <span
          class="absolute -left-0.5 h-1.5 w-1.5 rounded-full"
          style={{ background: 'var(--c-accent)', [side()]: '-2px' }}
        />
        <Show when={props.pinned !== undefined}>
          <span
            class="absolute right-1 rounded px-1 text-[9px] leading-[14px] font-semibold whitespace-nowrap"
            style={{ background: 'var(--c-accent)', color: 'var(--c-bg)', [side()]: '3px' }}
          >
            {props.pinned ? '📌 Pin' : 'Unpin'}
          </span>
        </Show>
      </div>
    </Show>
  )
}
