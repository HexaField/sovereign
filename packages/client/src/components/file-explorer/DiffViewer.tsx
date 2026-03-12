import { type Component, onMount, onCleanup } from 'solid-js'

interface DiffViewerProps {
  originalContent: string
  modifiedContent: string
  language?: string
  originalPath?: string
  modifiedPath?: string
}

const DiffViewer: Component<DiffViewerProps> = (props) => {
  let container: HTMLDivElement | undefined
  let editor: any = null

  onMount(async () => {
    const monaco = await import('monaco-editor')
    if (!container) return

    const originalModel = monaco.editor.createModel(props.originalContent, props.language ?? 'plaintext')
    const modifiedModel = monaco.editor.createModel(props.modifiedContent, props.language ?? 'plaintext')

    editor = monaco.editor.createDiffEditor(container, {
      theme: 'vs-dark',
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      fontSize: 13
    })

    editor.setModel({
      original: originalModel,
      modified: modifiedModel
    })
  })

  onCleanup(() => {
    editor?.dispose()
  })

  return <div ref={container} class="h-full w-full" />
}

export default DiffViewer
