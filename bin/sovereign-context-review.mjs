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

// ── Session kinds ─────────────────────────────────────────────────────
// The state file says whether a session is a subagent (it has a parent)
// and gives its label; the transcript itself carries neither.
const sessionInfo = new Map()
const stateDir = path.join(dataDir, 'agent-backend', 'claude-code-state')
for (const f of fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : []) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')).data ?? {}
    if (d.backendSessionId)
      sessionInfo.set(d.backendSessionId, { kind: d.parentSessionKey ? 'subagent' : 'thread', label: d.label })
  } catch {
    /* unreadable state file: the session counts as unknown */
  }
}
const kindOf = (id) => sessionInfo.get(id)?.kind ?? 'unknown'

// ── Transcripts ───────────────────────────────────────────────────────
const usage = { calls: 0, read: 0, write: 0, output: 0 }
/** Per kind: sessions, calls, cache reads, prompt tokens by size band. */
const BANDS = [100_000, 200_000, 400_000, Infinity]
const byKind = new Map()
const kindStats = (k) => {
  if (!byKind.has(k))
    byKind.set(k, { sessions: 0, calls: 0, read: 0, write: 0, output: 0, bands: BANDS.map(() => 0), compactions: [] })
  return byKind.get(k)
}
/** Per session: for the top list. */
const sessionStats = []
/** Tool results as the model received them (after the filter), by kind and tool, and Bash by command head. */
const seen = { tools: new Map(), bash: new Map() }
const addSeen = (map, key, chars) => {
  const a = map.get(key) ?? { n: 0, chars: 0 }
  a.n++
  a.chars += chars
  map.set(key, a)
}
const bashHead = (cmd) =>
  String(cmd)
    .replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, '')
    .replace(/^(\w+=\S+\s+)+/, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ')
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
    const id = f.slice(0, -'.jsonl'.length)
    const kind = kindOf(id)
    const ks = kindStats(kind)
    const ss = { id, kind, label: sessionInfo.get(id)?.label, calls: 0, read: 0, maxPrompt: 0 }
    const seenIds = new Set()
    const toolUses = new Map()
    let prev
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      const t = Date.parse(e.timestamp ?? '')
      // The SDK's own compaction leaves a boundary entry: Sovereign logs no metric for it.
      if (e.subtype === 'compact_boundary' && t >= since) ks.compactions.push(e.compactMetadata?.preTokens ?? 0)
      const msg = e.message
      if (!msg || typeof msg !== 'object' || !Number.isFinite(t)) continue
      if (t < since) {
        if (msg.usage) prev = t
        continue
      }
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b?.type !== 'tool_use' || !b.id || seenIds.has(b.id)) continue
          seenIds.add(b.id)
          toolUses.set(b.id, b)
          toolCalls++
          tools.set(b.name, (tools.get(b.name) ?? 0) + 1)
        }
      }
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b?.type !== 'tool_result') continue
          const use = toolUses.get(b.tool_use_id)
          const text =
            typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x?.text ?? '').join('')
          const name = use?.name ?? '?'
          addSeen(seen.tools, `${kind}\t${name}`, text.length)
          if (name === 'Bash') addSeen(seen.bash, bashHead(use.input?.command ?? ''), text.length)
        }
      }
      const u = msg.usage
      if (!u || (msg.id && seenIds.has(msg.id))) continue
      if (msg.id) seenIds.add(msg.id)
      const write = u.cache_creation_input_tokens ?? 0
      const read = u.cache_read_input_tokens ?? 0
      const prompt = write + read + (u.input_tokens ?? 0)
      usage.calls++
      usage.read += read
      usage.write += write
      usage.output += u.output_tokens ?? 0
      ks.calls++
      ks.read += read
      ks.write += write
      ks.output += u.output_tokens ?? 0
      ks.bands[BANDS.findIndex((b) => prompt < b)] += prompt
      ss.calls++
      ss.read += read
      if (prompt > ss.maxPrompt) ss.maxPrompt = prompt
      if (write > 50_000 && read < 0.2 * prompt) {
        const why = prev === undefined || t - prev > 3_600_000 ? 'idle' : 'other'
        cold[why].n++
        cold[why].tok += write
        const key = f.slice(0, 8)
        coldBySession.set(key, (coldBySession.get(key) ?? 0) + write)
      }
      prev = t
    }
    if (ss.calls) {
      ks.sessions++
      sessionStats.push(ss)
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
    } else if ((m = /\] (?:subagent-)?tool .*? out=(\d+) trimmed=(\d+)/.exec(line))) {
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

out.push('', '## Threads and subagents', '')
out.push(
  '| Kind | Sessions | Calls | Cache reads | Share | Avg prompt | Prompt tokens in calls < 100k / 100–200k / 200–400k / > 400k |',
  '|---|---|---|---|---|---|---|'
)
for (const [k, s] of [...byKind].sort((a, b) => b[1].read - a[1].read)) {
  const total = s.bands.reduce((a, b) => a + b, 0)
  out.push(
    `| ${k} | ${fmt(s.sessions)} | ${fmt(s.calls)} | ${fmt(s.read)} | ${pct(s.read, usage.read)} | ${fmt(total / (s.calls || 1))} | ${s.bands.map((b) => pct(b, total)).join(' / ')} |`
  )
}
for (const [k, s] of byKind)
  if (s.compactions.length)
    out.push('', `SDK compactions (${k}): ${fmt(s.compactions.length)}, median ${fmt(median(s.compactions))} tokens before.`)
out.push('', '### Most cache reads', '')
out.push('| Session | Kind | Label | Calls | Cache reads | Max prompt |', '|---|---|---|---|---|---|')
for (const s of sessionStats.sort((a, b) => b.read - a.read).slice(0, 10))
  out.push(`| ${s.id.slice(0, 8)} | ${s.kind} | ${s.label ?? ''} | ${fmt(s.calls)} | ${fmt(s.read)} | ${fmt(s.maxPrompt)} |`)

out.push('', '## Tool results the model saw (after the filter)', '')
out.push('| Kind | Tool | Results | Characters |', '|---|---|---|---|')
for (const [key, a] of [...seen.tools].sort((x, y) => y[1].chars - x[1].chars).slice(0, 15)) {
  const [k, name] = key.split('\t')
  out.push(`| ${k} | ${name} | ${fmt(a.n)} | ${fmt(a.chars)} |`)
}
out.push('', '| Bash command | Runs | Characters |', '|---|---|---|')
for (const [head, a] of [...seen.bash].sort((x, y) => y[1].chars - x[1].chars).slice(0, 10))
  out.push(`| \`${head.replace(/[|`]/g, '')}\` | ${fmt(a.n)} | ${fmt(a.chars)} |`)

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
    `| Tool-output filter (threads and subagents) | ${fmt(filter.hit)} of ${fmt(filter.results)} results trimmed, ${pct(filter.trimmed, filter.out)} of the raw tool responses |`
  )
  const top = [...bySession].sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (top.length) out.push('', `Most recycled: ${top.map(([s, n]) => `${s} (${n})`).join(', ')}.`)
}
console.log(out.join('\n'))
