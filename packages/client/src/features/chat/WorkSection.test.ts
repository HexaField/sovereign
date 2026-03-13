import { describe, it } from 'vitest'

describe('§4.4 WorkSection', () => {
  it.todo('MUST render between user message and assistant response')
  it.todo('MUST show tool calls with tool name, icon, and collapsible input preview')
  it.todo(
    'MUST map tool icons: read→📖, write→✏️, edit→✂️, exec→▶, process→⚙, browser→🌐, web_fetch→📡, memory_search→🔍, memory_get→📋, unknown→🔧'
  )
  it.todo('MUST pair tool results with corresponding tool calls by toolCallId')
  it.todo('MUST show green checkmark for success results and red ✗ for errors')
  it.todo('MUST render thinking blocks as expandable sections with var(--c-text-muted)')
  it.todo('MUST show "Thinking…" label when thinking block is collapsed')
  it.todo('MUST render system events inline with muted styling')
  it.todo('MUST collapse tool call inputs/results by default when exceeding 3 lines')
  it.todo('MUST provide "Show more" / "Show less" toggle for collapsed content')
  it.todo('MUST make thinking blocks collapsible, collapsed by default')
  it.todo('MUST make entire work section collapsible')
  it.todo('MUST expand work section by default while turn is in progress')
  it.todo('MUST collapse work section by default when turn is complete')
  it.todo('MUST show summary line when collapsed (e.g. "5 tool calls, 2 thinking blocks")')
  it.todo('MUST style work items with var(--c-step-bg) background and var(--c-work-border) border')
  it.todo('MUST show step count badge using Badge with var(--c-step-badge-bg)')
})
