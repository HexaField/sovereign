#!/usr/bin/env node
// Summarise runs.jsonl into markdown tables: per arm, per task (paired), and
// every run that failed or broke.
//
//   node report.mjs --out results/<id>   → prints and writes <out>/summary.md

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { readJsonl } from './lib.mjs'

const { values: args } = parseArgs({ options: { out: { type: 'string' } } })
const outDir = path.resolve(args.out)
// Runs recorded by GraphCoder's harness, before the move, name the tool graphcoder.
const runs = readJsonl(path.join(outDir, 'runs.jsonl')).map((r) => ({
  ...r,
  symbolEditCalls: r.symbolEditCalls ?? r.graphcoderCalls,
  mcp: { ...r.mcp, code: r.mcp?.code ?? r.mcp?.graphcoder }
}))

const ARMS = ['opus-base', 'opus-edit', 'local-base', 'local-edit'].filter((a) => runs.some((r) => r.arm === a))
const byArm = (arm) => runs.filter((r) => r.arm === arm)
const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN)
const median = (xs) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–')
const f0 = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en') : '–')
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–')
const num = (xs) => xs.filter((x) => typeof x === 'number')

const row = (cells) => `| ${cells.join(' | ')} |`
const table = (head, rows) => [row(head), `|${head.map(() => '---').join('|')}|`, ...rows.map(row)].join('\n')

const lines = [
  `# Symbol edit evaluation — ${path.basename(outDir)}`,
  '',
  `${runs.length} runs, ${new Set(runs.map((r) => r.task)).size} tasks.`,
  ''
]

lines.push('## Per arm', '')
lines.push(
  table(
    [
      'Arm',
      'Runs',
      'Pass',
      'Edit calls (mean)',
      'Failed edit calls (total / mean)',
      'symbol-edit share',
      'Reads (mean)',
      'Bash file writes (total)',
      'Output tokens (median)',
      'Turns (median)',
      'Timeouts',
      'symbol editor connected'
    ],
    ARMS.map((arm) => {
      const rs = byArm(arm)
      const edits = sum(rs.map((r) => r.editCalls))
      const symbolEdits = sum(rs.map((r) => r.symbolEditCalls))
      const connected = arm.endsWith('-edit')
        ? `${rs.filter((r) => r.mcp?.code === 'connected').length}/${rs.length}`
        : 'n/a'
      return [
        arm,
        rs.length,
        `${rs.filter((r) => r.pass).length} (${pct(rs.filter((r) => r.pass).length, rs.length)})`,
        f1(mean(rs.map((r) => r.editCalls))),
        `${sum(rs.map((r) => r.failedEdits))} / ${f1(mean(rs.map((r) => r.failedEdits)))}`,
        arm.endsWith('-edit') ? pct(symbolEdits, edits) : '–',
        f1(mean(rs.map((r) => r.reads))),
        sum(rs.map((r) => r.bashWrites)),
        f0(median(num(rs.map((r) => r.outputTokens)))),
        f0(median(num(rs.map((r) => r.turns)))),
        rs.filter((r) => r.timedOut).length,
        connected
      ]
    })
  ),
  ''
)

const tasks = [...new Set(runs.map((r) => r.task))]
lines.push('## Per task', '')
lines.push(
  table(
    ['Task', ...ARMS.flatMap((a) => [`${a} pass`, `${a} failed edits`, `${a} out tokens`])],
    tasks.map((t) => [
      t,
      ...ARMS.flatMap((a) => {
        const r = runs.find((x) => x.task === t && x.arm === a)
        return r ? [r.pass ? '✓' : '✗', r.failedEdits, f0(r.outputTokens)] : ['–', '–', '–']
      })
    ])
  ),
  ''
)

const paired = (a, b) => {
  const both = tasks
    .map((t) => [runs.find((r) => r.task === t && r.arm === a), runs.find((r) => r.task === t && r.arm === b)])
    .filter(([x, y]) => x && y)
  return {
    n: both.length,
    onlyA: both.filter(([x, y]) => x.pass && !y.pass).length,
    onlyB: both.filter(([x, y]) => !x.pass && y.pass).length,
    fewerFailedB: both.filter(([x, y]) => y.failedEdits < x.failedEdits).length,
    moreFailedB: both.filter(([x, y]) => y.failedEdits > x.failedEdits).length,
    tokenRatio: median(
      both.filter(([x, y]) => x.outputTokens && y.outputTokens).map(([x, y]) => y.outputTokens / x.outputTokens)
    )
  }
}
lines.push('## Paired (same task, base vs edit)', '')
lines.push(
  table(
    [
      'Model',
      'Pairs',
      'Pass: base only',
      'Pass: edit only',
      'Fewer failed edits with edit',
      'More failed edits with edit',
      'Output tokens edit/base (median ratio)'
    ],
    ['opus', 'local']
      .filter((m) => ARMS.includes(`${m}-base`) && ARMS.includes(`${m}-edit`))
      .map((m) => {
        const p = paired(`${m}-base`, `${m}-edit`)
        return [
          m,
          p.n,
          p.onlyA,
          p.onlyB,
          p.fewerFailedB,
          p.moreFailedB,
          Number.isFinite(p.tokenRatio) ? p.tokenRatio.toFixed(2) : '–'
        ]
      })
  ),
  ''
)

const bad = runs.filter(
  (r) => !r.pass || r.timedOut || r.touchedTests || (r.arm.endsWith('-edit') && r.mcp?.code !== 'connected')
)
lines.push('## Failed or suspect runs', '')
lines.push(
  bad.length
    ? table(
        ['Task', 'Arm', 'Tests', 'Why suspect', 'Stop reason', 'Turns'],
        bad.map((r) => [
          r.task,
          r.arm,
          r.testSummary,
          [
            r.timedOut && 'timed out',
            r.touchedTests && 'touched tests',
            r.arm.endsWith('-edit') && r.mcp?.code !== 'connected' && `symbol editor ${r.mcp?.code ?? 'absent'}`
          ]
            .filter(Boolean)
            .join(', ') || '–',
          r.subtype ?? '–',
          r.turns ?? '–'
        ])
      )
    : 'None.',
  ''
)

const md = lines.join('\n')
fs.writeFileSync(path.join(outDir, 'summary.md'), md + '\n')
console.log(md)
