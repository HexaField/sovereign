import type { ParsedTurn } from '@sovereign/core'

function formatRole(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

function formatTime(ts: number): string {
  return new Date(ts)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC')
}

export function exportAsMarkdown(turns: ParsedTurn[]): string {
  return turns
    .map((t) => {
      const header = `### ${formatRole(t.role)} — ${formatTime(t.timestamp)}`
      return `${header}\n\n${t.content}\n`
    })
    .join('\n---\n\n')
}

export function exportAsPdf(turns: ParsedTurn[]): Blob {
  // Basic implementation: wrap markdown export in a simple HTML document and return as blob
  const md = exportAsMarkdown(turns)
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Conversation Export</title></head><body><pre>${escapeHtml(md)}</pre></body></html>`
  return new Blob([html], { type: 'application/pdf' })
}

export function exportAsText(turns: ParsedTurn[]): string {
  return turns
    .map((t) => {
      return `[${formatRole(t.role)}] [${formatTime(t.timestamp)}]\n${t.content}\n`
    })
    .join('\n')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
