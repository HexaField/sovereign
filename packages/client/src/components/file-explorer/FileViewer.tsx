import { type Component, onMount, onCleanup } from 'solid-js'

interface FileViewerProps {
  path: string
  content?: string
  language?: string
  readOnly?: boolean
  onSave?: (content: string) => void
}

const FileViewer: Component<FileViewerProps> = (props) => {
  let container: HTMLDivElement | undefined
  let editor: any = null

  onMount(async () => {
    const monaco = await import('monaco-editor')
    if (!container) return

    editor = monaco.editor.create(container, {
      value: props.content ?? '',
      language: props.language ?? 'plaintext',
      theme: 'vs-dark',
      readOnly: props.readOnly ?? true,
      minimap: { enabled: false },
      automaticLayout: true,
      fontSize: 13,
      lineNumbers: 'on',
      scrollBeyondLastLine: false
    })

    // Cmd+S to save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (props.onSave) {
        props.onSave(editor.getValue())
      }
    })
  })

  onCleanup(() => {
    editor?.dispose()
  })

  return <div ref={container} class="h-full w-full" />
}

export default FileViewer
