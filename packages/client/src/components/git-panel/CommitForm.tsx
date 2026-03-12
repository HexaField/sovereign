import { type Component, createSignal } from 'solid-js'

interface CommitFormProps {
  onCommit: (message: string) => void
  disabled?: boolean
}

const CommitForm: Component<CommitFormProps> = (props) => {
  const [message, setMessage] = createSignal('')

  const handleSubmit = () => {
    const msg = message().trim()
    if (!msg) return
    props.onCommit(msg)
    setMessage('')
  }

  return (
    <div class="border-t border-zinc-700 p-2">
      <textarea
        class="w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
        rows={3}
        placeholder="Commit message..."
        value={message()}
        onInput={(e) => setMessage(e.currentTarget.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            handleSubmit()
          }
        }}
      />
      <button
        class="mt-1 w-full rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        disabled={!message().trim() || props.disabled}
        onClick={handleSubmit}
      >
        Commit
      </button>
    </div>
  )
}

export default CommitForm
