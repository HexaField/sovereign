import { type Component, onMount, onCleanup } from 'solid-js'

interface TerminalProps {
  sessionId: string
  onClose?: () => void
}

const Terminal: Component<TerminalProps> = (props) => {
  let container: HTMLDivElement | undefined
  let term: any = null
  let ws: WebSocket | null = null
  let fitAddon: any = null

  onMount(async () => {
    const { Terminal: XTerm } = await import('@xterm/xterm')
    const { FitAddon } = await import('@xterm/addon-fit')
    const { WebLinksAddon } = await import('@xterm/addon-web-links')

    if (!container) return

    term = new XTerm({
      theme: {
        background: '#09090b',
        foreground: '#d4d4d8',
        cursor: '#d4d4d8'
      },
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      cursorBlink: true
    })

    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    fitAddon.fit()

    // Connect WebSocket
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${location.host}/api/terminal?session=${props.sessionId}`)

    ws.onmessage = (event) => {
      term.write(event.data)
    }

    ws.onclose = () => {
      term.write('\r\n\x1b[31m[Disconnected]\x1b[0m\r\n')
    }

    term.onData((data: string) => {
      ws?.send(data)
    })

    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      ws?.send(JSON.stringify({ type: 'resize', cols, rows }))
    })

    // Handle container resize
    const observer = new ResizeObserver(() => {
      fitAddon?.fit()
    })
    observer.observe(container)

    onCleanup(() => {
      observer.disconnect()
    })
  })

  onCleanup(() => {
    ws?.close()
    term?.dispose()
  })

  return <div ref={container} class="h-full w-full" />
}

export default Terminal
