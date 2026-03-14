import type { ParsedTurn } from '@sovereign/core'

const BASE = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/'

// ── Markdown export ─────────────────────────────────────────────────

function turnToMarkdown(turn: ParsedTurn): string {
  const parts: string[] = []
  const ts = turn.timestamp ? formatTs(turn.timestamp) : ''

  if (turn.role === 'user') {
    parts.push(`**You**${ts ? ` — ${ts}` : ''}\n\n${turn.content}`)
  } else if (turn.role === 'assistant') {
    parts.push(`**Hex**${ts ? ` — ${ts}` : ''}\n\n${turn.content}`)
  } else if (turn.role === 'system') {
    parts.push(`⏰ Scheduled Result${ts ? ` — ${ts}` : ''}\n\n${turn.content}`)
  }

  return parts.join('\n\n')
}

function formatTs(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function turnsToMarkdown(turns: ParsedTurn[], threadName?: string): string {
  const header = `# Chat Export${threadName ? ` — ${threadName}` : ''}\n\n_Exported ${new Date().toLocaleString()}_\n\n---\n\n`
  const body = turns.map(turnToMarkdown).filter(Boolean).join('\n\n---\n\n')
  return header + body
}

export function messageToMarkdown(role: string, content: string, timestamp?: number): string {
  const ts = timestamp ? formatTs(timestamp) : ''
  const label = role === 'user' ? '**You**' : role === 'system' ? '⏰ Scheduled Result' : '**Hex**'
  return `${label}${ts ? ` — ${ts}` : ''}\n\n${content}`
}

// ── Download helpers ────────────────────────────────────────────────

export function downloadText(content: string, filename: string, mime = 'text/markdown') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ── PDF export via server (pandoc + typst) ──────────────────────────

async function downloadPdf(markdown: string, filename: string) {
  try {
    const res = await fetch(`${BASE}api/export/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown })
    })
    if (!res.ok) {
      console.error('PDF export failed:', await res.text())
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  } catch (err) {
    console.error('PDF export error:', err)
  }
}

export function exportThreadPdf(turns: ParsedTurn[], threadName?: string) {
  const md = turnsToMarkdown(turns, threadName)
  downloadPdf(md, `chat-export-${Date.now()}.pdf`)
}

export function exportMessagePdf(role: string, content: string, timestamp?: number) {
  const md = messageToMarkdown(role, content, timestamp)
  downloadPdf(md, `message-${Date.now()}.pdf`)
}
