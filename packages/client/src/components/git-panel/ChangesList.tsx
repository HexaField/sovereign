import { type Component, For, Show } from 'solid-js'
import type { FileChange } from './types.js'

interface ChangesListProps {
  staged: FileChange[]
  modified: FileChange[]
  untracked: string[]
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onStageAll: () => void
  onUnstageAll: () => void
  onFileClick: (path: string) => void
}

const statusIcon: Record<string, string> = {
  added: '+',
  modified: '~',
  deleted: '-',
  renamed: '>'
}

const ChangesList: Component<ChangesListProps> = (props) => {
  return (
    <div class="space-y-2 text-xs">
      {/* Staged */}
      <Show when={props.staged.length > 0}>
        <div>
          <div class="flex items-center justify-between px-2 py-1 text-zinc-400">
            <span class="font-semibold uppercase">Staged ({props.staged.length})</span>
            <button class="text-zinc-500 hover:text-zinc-300" onClick={props.onUnstageAll}>
              Unstage All
            </button>
          </div>
          <For each={props.staged}>
            {(file) => (
              <div
                class="flex cursor-pointer items-center justify-between px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
                onClick={() => props.onFileClick(file.path)}
              >
                <span>
                  {statusIcon[file.status] ?? '⚪'} {file.path}
                </span>
                <button
                  class="text-zinc-500 hover:text-zinc-300"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onUnstage(file.path)
                  }}
                >
                  −
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Modified */}
      <Show when={props.modified.length > 0}>
        <div>
          <div class="flex items-center justify-between px-2 py-1 text-zinc-400">
            <span class="font-semibold uppercase">Modified ({props.modified.length})</span>
            <button class="text-zinc-500 hover:text-zinc-300" onClick={props.onStageAll}>
              Stage All
            </button>
          </div>
          <For each={props.modified}>
            {(file) => (
              <div
                class="flex cursor-pointer items-center justify-between px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
                onClick={() => props.onFileClick(file.path)}
              >
                <span>
                  {statusIcon[file.status] ?? '⚪'} {file.path}
                </span>
                <button
                  class="text-zinc-500 hover:text-zinc-300"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onStage(file.path)
                  }}
                >
                  +
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Untracked */}
      <Show when={props.untracked.length > 0}>
        <div>
          <div class="px-2 py-1 text-zinc-400">
            <span class="font-semibold uppercase">Untracked ({props.untracked.length})</span>
          </div>
          <For each={props.untracked}>
            {(path) => (
              <div
                class="flex cursor-pointer items-center justify-between px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
                onClick={() => props.onFileClick(path)}
              >
                <span>❓ {path}</span>
                <button
                  class="text-zinc-500 hover:text-zinc-300"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onStage(path)
                  }}
                >
                  +
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export default ChangesList
