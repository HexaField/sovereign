// Mermaid diagrams in rendered markdown: each ```mermaid block becomes an SVG
// once the HTML sits in the DOM. Mermaid loads on first use, so a page with
// no diagram never downloads it.

import type { Mermaid } from 'mermaid'
import { currentTheme } from '../features/theme/store.js'

let loader: Promise<Mermaid> | null = null
let initialisedTheme: string | null = null
let nextId = 0

function loadMermaid(): Promise<Mermaid> {
  loader ??= import('mermaid').then((m) => m.default)
  return loader
}

/** Mermaid's theme for a Sovereign theme: only "light" is light. */
export function mermaidTheme(theme: string): 'default' | 'dark' {
  return theme === 'light' ? 'default' : 'dark'
}

/** The ```mermaid code blocks under `root`, as marked renders them. */
export function mermaidBlocks(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('pre > code.language-mermaid'))
}

/**
 * Replace each ```mermaid block under `root` with its diagram. A block that
 * does not parse keeps its source, with the error above it. Stops as soon as
 * `isCurrent()` turns false, so stale content never overwrites newer content.
 */
export async function renderMermaidIn(root: HTMLElement, isCurrent: () => boolean = () => true): Promise<void> {
  const blocks = mermaidBlocks(root)
  if (!blocks.length) return
  const mermaid = await loadMermaid()
  const theme = mermaidTheme(currentTheme())
  if (initialisedTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
    initialisedTheme = theme
  }
  for (const code of blocks) {
    const pre = code.parentElement!
    const id = `mermaid-${++nextId}`
    try {
      const { svg, bindFunctions } = await mermaid.render(id, code.textContent ?? '')
      if (!isCurrent()) return
      if (!pre.isConnected) continue
      const figure = document.createElement('div')
      figure.className = 'mermaid-diagram'
      figure.innerHTML = svg
      pre.replaceWith(figure)
      bindFunctions?.(figure)
    } catch (err) {
      // A failed render leaves its error graphic in <body>.
      document.getElementById(`d${id}`)?.remove()
      if (!isCurrent()) return
      if (!pre.isConnected) continue
      const note = document.createElement('div')
      note.className = 'mermaid-error'
      note.textContent = `Mermaid: ${(err as Error).message}`
      pre.before(note)
    }
  }
}
