import { render } from 'solid-js/web'
import { renderMarkdown, escapeHtml } from './lib/markdown.js'
import App from './App'
import './app.css'

render(() => <App />, document.getElementById('root') as HTMLElement)

function openFileInWorkspace(filePath: string): void {
  window.dispatchEvent(new CustomEvent('sovereign:open-file', { detail: { path: filePath } }))
}

// Also handle middle-click (auxclick) for file chips
document.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return
  const chip = (e.target as HTMLElement).closest('.file-chip') as HTMLElement | null
  if (!chip?.dataset.filePath) return
  e.preventDefault()
  openFileInWorkspace(chip.dataset.filePath!)
})

// Global click handler for file-chip elements
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement

  // Handle copy button clicks inside file chips
  const copyBtn = target.closest('.file-chip-copy') as HTMLElement | null
  if (copyBtn) {
    e.preventDefault()
    e.stopPropagation()
    const path = copyBtn.getAttribute('data-copy-path') || ''
    if (path) {
      navigator.clipboard.writeText(path).then(() => {
        const orig = copyBtn.textContent
        copyBtn.textContent = '✓'
        setTimeout(() => {
          copyBtn.textContent = orig
        }, 1500)
      })
    }
    return
  }

  // Handle "Open in workspace" button inside expanded panel
  const openBtn = target.closest('.file-chip-expanded-open') as HTMLElement | null
  if (openBtn) {
    e.preventDefault()
    e.stopPropagation()
    const path = openBtn.getAttribute('data-file-path') || ''
    if (path) openFileInWorkspace(path)
    return
  }

  const chip = target.closest('.file-chip') as HTMLElement | null
  if (!chip?.dataset.filePath) return
  e.preventDefault()
  e.stopPropagation()
  const filePath = chip.dataset.filePath!

  // Ctrl/Cmd+click opens file in workspace
  if (e.metaKey || e.ctrlKey) {
    openFileInWorkspace(filePath)
    return
  }

  // Regular click: toggle inline file viewer
  const existing = chip.nextElementSibling as HTMLElement | null
  if (existing?.classList.contains('file-chip-expanded')) {
    existing.remove()
    return
  }

  const panel = document.createElement('div')
  panel.className = 'file-chip-expanded'
  panel.innerHTML = `<div class="file-chip-expanded-header"><span class="file-chip-expanded-path">${escapeHtml(filePath)}</span><div style="display:flex;gap:4px;flex-shrink:0"><button class="file-chip-expanded-open" data-file-path="${escapeHtml(filePath)}" title="Open in workspace">↗</button><button class="file-chip-expanded-close">✕</button></div></div><div class="file-chip-expanded-body"><span class="file-chip-expanded-loading">Loading…</span></div>`
  chip.insertAdjacentElement('afterend', panel)

  panel.querySelector('.file-chip-expanded-close')!.addEventListener('click', () => panel.remove())

  // Fetch file content via workspace read API
  fetch(`/api/files/workspace/read?path=${encodeURIComponent(filePath)}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
    .then((data: { content: string; extension: string }) => {
      const body = panel.querySelector('.file-chip-expanded-body')!
      const ext = data.extension || filePath.split('.').pop()?.toLowerCase() || ''

      if (ext === 'md' || ext === 'markdown') {
        // Render markdown
        body.innerHTML = `<div class="file-chip-markdown">${renderMarkdown(data.content)}</div>`
      } else {
        // Render code with line numbers
        const lines = data.content.split('\n')
        const lineNums = lines.map((_, i) => `<span class="file-chip-line-num">${i + 1}</span>`).join('\n')
        const code = escapeHtml(data.content)
        body.innerHTML = `<div class="file-chip-code"><pre class="file-chip-line-nums">${lineNums}</pre><pre class="file-chip-code-content"><code class="language-${ext}">${code}</code></pre></div>`
      }
    })
    .catch((err) => {
      const body = panel.querySelector('.file-chip-expanded-body')
      if (body) body.innerHTML = `<span style="color:var(--c-text-muted)">Failed to load: ${err.message}</span>`
    })
})
