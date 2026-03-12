import { type Component, onCleanup, createSignal } from 'solid-js'

interface DividerProps {
  direction: 'horizontal' | 'vertical'
  onResize: (delta: number) => void
}

const Divider: Component<DividerProps> = (props) => {
  const [dragging, setDragging] = createSignal(false)
  let startPos = 0

  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault()
    startPos = props.direction === 'horizontal' ? e.clientX : e.clientY
    setDragging(true)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  const onMouseMove = (e: MouseEvent) => {
    const current = props.direction === 'horizontal' ? e.clientX : e.clientY
    const delta = current - startPos
    startPos = current
    props.onResize(delta)
  }

  const onMouseUp = () => {
    setDragging(false)
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }

  onCleanup(() => {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  })

  const isHorizontal = () => props.direction === 'horizontal'

  return (
    <div
      class={`flex-shrink-0 ${isHorizontal() ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"} ${dragging() ? 'bg-blue-500' : "bg-zinc-700 hover:bg-zinc-500"} transition-colors`}
      onMouseDown={onMouseDown}
    />
  )
}

export default Divider
