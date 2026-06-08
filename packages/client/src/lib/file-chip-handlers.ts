import { renderMarkdown, escapeHtml } from './markdown.js'

function openFileInWorkspace(filePath: string): void {
  window.dispatchEvent(new CustomEvent('sovereign:open-file', { detail: { path: filePath } }))
}

function openFileInNewTab(filePath: string): void {
  const url = new URL(window.location.href)
  url.searchParams.set('view', 'workspace')
  url.searchParams.set('file', filePath)
  window.open(url.toString(), '_blank')
}

export function registerFileChipHandlers(): void {
  // Middle-click on file chips
  document.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    const chip = (e.target as HTMLElement).closest('.file-chip') as HTMLElement | null
    if (!chip?.dataset.filePath) return
    e.preventDefault()
    openFileInNewTab(chip.dataset.filePath!)
  })

  // Global click handler for file-chip elements
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement

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

    if (e.metaKey || e.ctrlKey) {
      openFileInNewTab(filePath)
      return
    }

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

    fetch(`/api/files/workspace/read?path=${encodeURIComponent(filePath)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data: { content: string; extension: string }) => {
        const body = panel.querySelector('.file-chip-expanded-body')!
        const ext = data.extension || filePath.split('.').pop()?.toLowerCase() || ''

        if (ext === 'md' || ext === 'markdown') {
          body.innerHTML = `<div class="file-chip-markdown">${renderMarkdown(data.content)}</div>`
        } else {
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
}
