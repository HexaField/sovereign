// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: mermaid }))

import { mermaidBlocks, mermaidTheme, renderMermaidIn } from './mermaid.js'

function doc(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.replaceChildren(root)
  return root
}

const fence = (src: string) => `<pre><code class="language-mermaid">${src}</code></pre>`

beforeEach(() => {
  mermaid.initialize.mockClear()
  mermaid.render.mockReset()
})

describe('mermaidTheme', () => {
  it('uses the light mermaid theme only for the light Sovereign theme', () => {
    expect(mermaidTheme('light')).toBe('default')
    for (const t of ['default', 'ironman', 'jarvis']) expect(mermaidTheme(t)).toBe('dark')
  })
})

describe('mermaidBlocks', () => {
  it('finds only ```mermaid fences', () => {
    const root = doc(
      `${fence('graph TD; A-->B')}<pre><code class="language-ts">x</code></pre><code class="language-mermaid">inline</code>`
    )
    expect(mermaidBlocks(root).map((c) => c.textContent)).toEqual(['graph TD; A-->B'])
  })
})

describe('renderMermaidIn', () => {
  it('replaces each block with its diagram and leaves other code alone', async () => {
    mermaid.render.mockImplementation(async (_id: string, src: string) => ({ svg: `<svg data-src="${src}"></svg>` }))
    const root = doc(`${fence('graph TD; A-->B')}<pre><code class="language-ts">x</code></pre>${fence('pie')}`)
    await renderMermaidIn(root)
    expect([...root.querySelectorAll('.mermaid-diagram svg')].map((s) => s.getAttribute('data-src'))).toEqual([
      'graph TD; A-->B',
      'pie'
    ])
    expect(root.querySelector('code.language-ts')).not.toBeNull()
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict' })
    )
  })

  it('keeps the source of a block that fails to parse, with the error above it', async () => {
    mermaid.render.mockImplementation(async (id: string) => {
      const leftover = document.createElement('div')
      leftover.id = `d${id}`
      document.body.append(leftover)
      throw new Error('Parse error on line 1')
    })
    const root = doc(fence('not a diagram'))
    await renderMermaidIn(root)
    expect(root.querySelector('.mermaid-error')?.textContent).toBe('Mermaid: Parse error on line 1')
    expect(root.querySelector('code.language-mermaid')?.textContent).toBe('not a diagram')
    expect(document.querySelectorAll('[id^="dmermaid-"]')).toHaveLength(0)
  })

  it('stops once the content is stale', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg></svg>' })
    const root = doc(fence('graph TD; A-->B'))
    await renderMermaidIn(root, () => false)
    expect(root.querySelector('.mermaid-diagram')).toBeNull()
    expect(root.querySelector('code.language-mermaid')).not.toBeNull()
  })

  it('does not load mermaid when there is no diagram', async () => {
    await renderMermaidIn(doc('<p>text</p>'))
    expect(mermaid.render).not.toHaveBeenCalled()
  })
})
