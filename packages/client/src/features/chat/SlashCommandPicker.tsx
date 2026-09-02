import { For, Show } from 'solid-js'
import type { SlashCommand } from './slash-commands.js'

export interface SlashCommandPickerProps {
  commands: SlashCommand[]
  selectedIndex: number
  onSelect: (command: SlashCommand) => void
}

/**
 * Floating command palette that appears when the chat input starts with "/".
 * Positioned above the input area. Keyboard navigation is managed by the
 * parent InputArea; this component only handles mouse interaction.
 *
 * Accessibility note: onMouseDown={preventDefault} keeps textarea focus so
 * the onClick still fires without the input losing its selection.
 */
export function SlashCommandPicker(props: SlashCommandPickerProps) {
  return (
    <Show when={props.commands.length > 0}>
      <div
        class="absolute right-0 bottom-full left-0 z-50 mx-4 mb-1 overflow-hidden rounded-xl shadow-lg"
        style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
        data-testid="slash-command-picker"
      >
        {/* Header */}
        <div
          class="flex items-center justify-between px-4 py-2"
          style={{ 'border-bottom': '1px solid var(--c-border)' }}
        >
          <span class="text-xs font-medium tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
            Commands
          </span>
          <span class="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
            ↑↓ &middot; Enter to select &middot; Esc to dismiss
          </span>
        </div>

        {/* Command list */}
        <div class="max-h-48 overflow-y-auto">
          <For each={props.commands}>
            {(cmd, idx) => (
              <button
                class="flex w-full cursor-pointer flex-col gap-0.5 border-none px-4 py-2.5 text-left transition-colors"
                style={{
                  background: idx() === props.selectedIndex ? 'var(--c-bg-raised)' : 'transparent',
                  color: 'var(--c-text)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--c-bg-raised)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background =
                    idx() === props.selectedIndex ? 'var(--c-bg-raised)' : 'transparent'
                }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.onSelect(cmd)}
              >
                <span class="text-sm">
                  <span class="font-medium" style={{ color: 'var(--c-accent)' }}>
                    /{cmd.command}
                  </span>
                  <span class="ml-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                    {cmd.description}
                  </span>
                </span>
                <Show when={cmd.usage}>
                  <code class="text-[11px]" style={{ color: 'var(--c-text-muted)', opacity: '0.65' }}>
                    {cmd.usage}
                  </code>
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}
