#!/usr/bin/env node
// Context review: one window (default 7 days) of how Claude sessions use and
// spend context. Prints Markdown.
//
//   node bin/sovereign-context-review.mjs [--days 7] [--data ~/.sovereign/data]
//                                          [--projects ~/.claude/projects]
//
// Sources:
// - Session transcripts (<projects>/*/*.jsonl): API usage per call (cache
//   reads, cache writes, output) and tool_use blocks. One call counts once per
//   message id (Claude Code writes one line per content block).
// - The server log (<data>/logs/sovereign.stdout.log): `[metrics]` lines for
//   auto-recycle, context-strategy (the cozempic pass) and the tool-output
//   filter. Only lines that end in ` at=<ISO time>` fall in a window; older
//   lines have no time and are skipped.
//
// A "cold rewrite" is a call that writes over 50k tokens to the cache while
// reading under 20% of its prompt from it: the prompt cache had expired or
// the prompt changed early on. Over 60 minutes since the session's previous
// call means the cache TTL ran out.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const home = os.homedir()
const days = Number(opt('days', '7'))
const dataDir = opt('data', path.join(home, '.sovereign', 'data'))
const projectsDir = opt('projects', path.join(home, '.claude', 'projects'))
const until = Date.now()
const since = until - days * 86_400_000

const fmt = (n) => Math.round(n).toLocaleString('en-US')
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '–')
const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ── Transcripts ───────────────────────────────────────────────────────
const usage = { calls: 0, read: 0, write: 0, output: 0 }
const cold = { idle: { n: 0, tok: 0 }, other: { n: 0, tok: 0 } }
const coldBySession = new Map()
const tools = new Map()
let toolCalls = 0
let files = 0

for (const dir of fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : []) {
  const full = path.join(projectsDir, dir)
  if (!fs.statSync(full).isDirectory()) continue
  for (const f of fs.readdirSync(full)) {
    if (!f.endsWith('.jsonl')) continue
    const file = path.join(full, f)
    if (fs.statSync(file).mtimeMs < since) continue
    files++
    const seen = new Set()
    let prev
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      const msg = e.message
      const t = Date.parse(e.timestamp ?? '')
      if (!msg || typeof msg !== 'object' || !Number.isFinite(t)) continue
      if (t < since) {
        if (msg.usage) prev = t
        continue
      }
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b?.type !== 'tool_use' || !b.id || seen.has(b.id)) continue
          seen.add(b.id)
          toolCalls++
          tools.set(b.name, (tools.get(b.name) ?? 0) + 1)
        }
      }
      const u = msg.usage
      if (!u || (msg.id && seen.has(msg.id))) continue
      if (msg.id) seen.add(msg.id)
      const write = u.cache_creation_input_tokens ?? 0
      const read = u.cache_read_input_tokens ?? 0
      const prompt = write + read + (u.input_tokens ?? 0)
      usage.calls++
      usage.read += read
      usage.write += write
      usage.output += u.output_tokens ?? 0
      if (write > 50_000 && read < 0.2 * prompt) {
        const kind = prev === undefined || t - prev > 3_600_000 ? 'idle' : 'other'
        cold[kind].n++
        cold[kind].tok += write
        const key = f.slice(0, 8)
        coldBySession.set(key, (coldBySession.get(key) ?? 0) + write)
      }
      prev = t
    }
  }
}

// ── Server log ────────────────────────────────────────────────────────
const recycles = []
const strategies = []
const filter = { results: 0, out: 0, trimmed: 0, hit: 0 }
let untimed = 0
const logFile = path.join(dataDir, 'logs', 'sovereign.stdout.log')
if (fs.existsSync(logFile)) {
  for (const line of fs.readFileSync(logFile, 'latin1').split('\n')) {
    if (!line.includes('[metrics] ')) continue
    const at = / at=(\S+)$/.exec(line)
    if (!at) {
      untimed++
      continue
    }
    const t = Date.parse(at[1])
    if (!(t >= since && t <= until)) continue
    let m
    if ((m = /\] auto-recycle session=(\S+) .*?pre=(\d+) post=(\d+) reclaimed=(\d+)/.exec(line))) {
      recycles.push({ session: m[1], pre: +m[2], reclaimed: +m[4] })
    } else if ((m = /\] context-strategy .*?\(([\d.]+)%\)/.exec(line))) {
      strategies.push(+m[1])
    } else if ((m = /\] tool .*? out=(\d+) trimmed=(\d+)/.exec(line))) {
      filter.results++
      filter.out += +m[1]
      filter.trimmed += +m[2]
      if (+m[2] > 0) filter.hit++
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────
const out = []
const day = (ms) => new Date(ms).toISOString().slice(0, 10)
out.push(`# Context review: ${day(since)} to ${day(until)}`, '')
out.push('## Prompt cache', '')
out.push('| Measure | Value |', '|---|---|')
out.push(`| Transcripts | ${fmt(files)} |`)
out.push(`| API calls | ${fmt(usage.calls)} |`)
out.push(`| Cache reads | ${fmt(usage.read)} tokens |`)
out.push(`| Cache writes | ${fmt(usage.write)} tokens |`)
out.push(`| Cache hit rate (reads / reads + writes) | ${pct(usage.read, usage.read + usage.write)} |`)
out.push(`| Output | ${fmt(usage.output)} tokens |`)
out.push(
  `| Cold rewrites after > 60 min idle | ${fmt(cold.idle.n)} calls, ${fmt(cold.idle.tok)} tokens (${pct(cold.idle.tok, usage.write)} of writes) |`
)
out.push(`| Cold rewrites without idle (restart, recycle) | ${fmt(cold.other.n)} calls, ${fmt(cold.other.tok)} tokens |`)
const topCold = [...coldBySession].sort((a, b) => b[1] - a[1]).slice(0, 5)
if (topCold.length) out.push('', `Most cold-rewrite tokens: ${topCold.map(([s, n]) => `${s} ${fmt(n)}`).join(', ')}.`)

out.push('', '## Tool calls', '')
out.push('| Tool | Calls | Share |', '|---|---|---|')
for (const [name, n] of [...tools].sort((a, b) => b[1] - a[1]).slice(0, 20))
  out.push(`| ${name} | ${fmt(n)} | ${pct(n, toolCalls)} |`)
out.push(`| **All** | **${fmt(toolCalls)}** | |`)

out.push('', '## Context management (server log)', '')
if (!recycles.length && !strategies.length && !filter.results) {
  out.push(`No timed \`[metrics]\` lines in this window (${fmt(untimed)} older lines have no time).`)
} else {
  const share = recycles.map((r) => (r.pre ? (r.reclaimed / r.pre) * 100 : 0))
  const bySession = new Map()
  for (const r of recycles) bySession.set(r.session, (bySession.get(r.session) ?? 0) + 1)
  out.push('| Measure | Value |', '|---|---|')
  out.push(`| Auto-recycles | ${fmt(recycles.length)} in ${fmt(bySession.size)} sessions |`)
  out.push(`| Median reclaimed | ${median(share).toFixed(1)}% of the context |`)
  out.push(
    `| Reclaimed < 5% / ≥ 30% | ${fmt(share.filter((s) => s < 5).length)} / ${fmt(share.filter((s) => s >= 30).length)} |`
  )
  out.push(`| Tokens reclaimed | ${fmt(recycles.reduce((a, r) => a + r.reclaimed, 0))} |`)
  out.push(`| Cozempic passes, median saved (of the transcript file) | ${fmt(strategies.length)}, ${median(strategies).toFixed(1)}% |`)
  out.push(
    `| Tool-output filter | ${fmt(filter.hit)} of ${fmt(filter.results)} results trimmed, ${pct(filter.trimmed, filter.out)} of output |`
  )
  const top = [...bySession].sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (top.length) out.push('', `Most recycled: ${top.map(([s, n]) => `${s} (${n})`).join(', ')}.`)
}
console.log(out.join('\n'))
