import { render } from 'solid-js/web'
import App from './App'
import './app.css'

render(() => <App />, document.getElementById('root') as HTMLElement)

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

  const chip = target.closest('.file-chip') as HTMLElement | null
  if (!chip?.dataset.filePath) return
  e.preventDefault()
  e.stopPropagation()
  const filePath = chip.dataset.filePath!

  // Ctrl/Cmd+click copies path to clipboard
  if (e.metaKey || e.ctrlKey) {
    navigator.clipboard.writeText(filePath)
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
  panel.innerHTML = `<div class="file-chip-expanded-header"><span class="file-chip-expanded-path">${filePath}</span><button class="file-chip-expanded-close">✕</button></div><div class="file-chip-expanded-body"><span class="file-chip-expanded-loading">Loading…</span></div>`
  chip.insertAdjacentElement('afterend', panel)

  panel.querySelector('.file-chip-expanded-close')!.addEventListener('click', () => panel.remove())

  // Fetch file content via the files API
  fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
    .then((content) => {
      const ext = filePath.split('.').pop()?.toLowerCase() || ''
      const body = panel.querySelector('.file-chip-expanded-body')!
      body.innerHTML = `<pre><code class="language-${ext}">${content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`
    })
    .catch((err) => {
      const body = panel.querySelector('.file-chip-expanded-body')
      if (body) body.innerHTML = `<span style="color:var(--c-text-muted)">Failed to load: ${err.message}</span>`
    })
})
