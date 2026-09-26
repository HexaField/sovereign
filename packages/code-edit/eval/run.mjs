#!/usr/bin/env node
// Run the evaluation arms for one lane. A lane owns one model; its two arms
// differ only in whether the symbol editor (and one line of steering
// toward it) is available. Each task gets a fresh checkout; the arms run on
// it in turn, reset in between. Results append to <out>/runs.jsonl; a rerun
// skips (task, arm) pairs already recorded.
//
//   node run.mjs --tasks tasks.json --out results/<id> --lane opus|local --claude <bin> [--only id,id]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { git, prepareCheckout, readJsonl, runTests, sh, writeTests } from './lib.mjs'

const { values: args } = parseArgs({
  options: {
    tasks: { type: 'string', default: 'tasks.json' },
    out: { type: 'string' },
    lane: { type: 'string' },
    claude: { type: 'string', default: 'claude' },
    repo: { type: 'string' },
    only: { type: 'string' },
    'max-turns': { type: 'string', default: '60' },
    work: { type: 'string', default: path.join(os.homedir(), '.cache', 'symbol-edit-eval', 'runs') }
  }
})

const LANES = {
  opus: { model: 'claude-opus-5-5', timeoutMs: 20 * 60_000, env: {} },
  local: {
    model: 'qwen3.8-27b',
    timeoutMs: 60 * 60_000,
    env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_API_KEY: 'litellm' }
  }
}
const lane = LANES[args.lane]
if (!lane || !args.out || !args.repo) throw new Error('--lane (opus|local), --out and --repo are required')
const repo = path.resolve(args.repo)
const outDir = path.resolve(args.out)
fs.mkdirSync(outDir, { recursive: true })
const runsFile = path.join(outDir, 'runs.jsonl')

const STEER =
  'To change code in a named symbol (rewrite, insert beside, remove, or edit inside a function/class/method), use mcp__code__edit — no Read needed first — instead of Read + Edit with a long old_string.'

const SYMBOL_EDIT = 'mcp__code__edit'
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', SYMBOL_EDIT])
/** This checkout's own build of the symbol editor, the server under test. */
const CODE_EDIT_SERVER = fileURLToPath(new URL('../dist/mcp.js', import.meta.url))
const BASH_WRITE = /\bsed\s+-i|\bperl\s+-p?i|>\s*\S+\.(?:ts|tsx|js|json|md)\b|writeFileSync|\bpython3?\s+-\s*<</

function prompt(task, dir) {
  return [
    `Implement this change in the repository at ${dir}:`,
    '',
    task.subject,
    ...(task.body ? ['', task.body] : []),
    '',
    `These tests must pass: ${task.tests.join(' ')}`,
    `Run them with: npx vitest run ${task.tests.join(' ')}`,
    '',
    `Do not modify the test files. Work only inside ${dir}; its git history holds no answer. Stop when the tests pass.`
  ].join('\n')
}

function mcpConfig(arm, dir) {
  const servers = { codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] } }
  if (arm.endsWith('-edit')) {
    servers.code = { type: 'stdio', command: process.execPath, args: [CODE_EDIT_SERVER, '--edit-roots', dir] }
  }
  return { mcpServers: servers }
}

/** Metrics from a stream-json transcript. */
function metrics(file) {
  const m = {
    mcp: {},
    tools: {},
    editCalls: 0,
    symbolEditCalls: 0,
    failedEdits: 0,
    failedSymbolEdits: 0,
    reads: 0,
    bashWrites: 0,
    toolErrors: 0,
    turns: null,
    outputTokens: null,
    inputTokens: null,
    costUsd: null,
    durationMs: null,
    subtype: null,
    isError: null
  }
  const names = new Map()
  const usageById = new Map()
  for (const ev of readJsonl(file)) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      for (const s of ev.mcp_servers ?? []) m.mcp[s.name] = s.status
    } else if (ev.type === 'assistant') {
      if (ev.message?.id && ev.message.usage) usageById.set(ev.message.id, ev.message.usage)
      for (const c of ev.message?.content ?? []) {
        if (c.type !== 'tool_use') continue
        names.set(c.id, c.name)
        m.tools[c.name] = (m.tools[c.name] ?? 0) + 1
        if (EDIT_TOOLS.has(c.name)) m.editCalls++
        if (c.name === SYMBOL_EDIT) m.symbolEditCalls++
        if (c.name === 'Read') m.reads++
        if (c.name === 'Bash' && BASH_WRITE.test(String(c.input?.command ?? ''))) m.bashWrites++
      }
    } else if (ev.type === 'user') {
      for (const c of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (c.type !== 'tool_result' || !c.is_error) continue
        m.toolErrors++
        const name = names.get(c.tool_use_id)
        if (EDIT_TOOLS.has(name)) m.failedEdits++
        if (name === SYMBOL_EDIT) m.failedSymbolEdits++
      }
    } else if (ev.type === 'result') {
      m.turns = ev.num_turns ?? null
      m.costUsd = ev.total_cost_usd ?? null
      m.durationMs = ev.duration_ms ?? null
      m.subtype = ev.subtype ?? null
      m.isError = ev.is_error ?? null
      if (ev.usage) {
        m.outputTokens = ev.usage.output_tokens ?? null
        m.inputTokens =
          (ev.usage.input_tokens ?? 0) + (ev.usage.cache_read_input_tokens ?? 0) + (ev.usage.cache_creation_input_tokens ?? 0)
      }
    }
  }
  if (m.outputTokens === null && usageById.size) {
    m.outputTokens = [...usageById.values()].reduce((n, u) => n + (u.output_tokens ?? 0), 0)
  }
  return m
}

async function runArm(task, arm, dir, index) {
  const base = path.join(outDir, `${task.id}-${arm}`)
  await git(dir, 'reset', '-q', '--hard', 'HEAD')
  await git(dir, 'clean', '-fdq', '-e', '.codegraph')
  await sh('codegraph', ['sync', '-q', dir])
  fs.writeFileSync(`${base}.mcp.json`, JSON.stringify(mcpConfig(arm, dir), null, 2))

  const env = { ...process.env, ...lane.env, CODEGRAPH_NO_DAEMON: '1' }
  if (!lane.env.ANTHROPIC_BASE_URL) {
    delete env.ANTHROPIC_BASE_URL
    delete env.ANTHROPIC_API_KEY
  }
  const cli = [
    '-p', prompt(task, dir),
    '--model', lane.model,
    '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', `${base}.mcp.json`,
    '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions',
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', args['max-turns'],
    '--no-session-persistence',
    ...(arm.endsWith('-edit') ? ['--append-system-prompt', STEER] : [])
  ]
  const started = new Date().toISOString()
  const run = await sh(args.claude, cli, { cwd: dir, env, timeoutMs: lane.timeoutMs, stdoutFile: `${base}.jsonl` })
  if (run.stderr.trim()) fs.writeFileSync(`${base}.stderr.txt`, run.stderr)

  const touched = (await git(dir, 'status', '--porcelain', '--', ...task.tests)).trim() !== ''
  await git(dir, 'checkout', '-q', 'HEAD', '--', ...task.tests)
  const tests = await runTests(dir, task.tests)
  const changed = (await git(dir, 'status', '--porcelain')).split('\n').filter((l) => l && !l.includes('.codegraph')).length
  const diffStat = (await git(dir, 'diff', '--shortstat', 'HEAD')).trim()

  const record = {
    task: task.id,
    arm,
    model: lane.model,
    order: index,
    startedAt: started,
    pass: tests.pass,
    testSummary: tests.summary,
    touchedTests: touched,
    filesChanged: changed,
    diffStat,
    timedOut: run.timedOut,
    exitCode: run.code,
    ...metrics(`${base}.jsonl`)
  }
  fs.appendFileSync(runsFile, JSON.stringify(record) + '\n')
  console.log(
    `${task.id} ${arm.padEnd(10)} ${record.pass ? 'PASS' : 'fail'} turns=${record.turns} out=${record.outputTokens} edits=${record.editCalls} (symbol ${record.symbolEditCalls}) failed=${record.failedEdits}${record.timedOut ? ' TIMEOUT' : ''}`
  )
}

const tasks = JSON.parse(fs.readFileSync(args.tasks, 'utf8')).filter((t) => !args.only || args.only.split(',').includes(t.id))
const arms = [`${args.lane}-base`, `${args.lane}-edit`]
const done = new Set(readJsonl(runsFile).map((r) => `${r.task}:${r.arm}`))

for (const [i, task] of tasks.entries()) {
  const todo = arms.filter((a) => !done.has(`${task.id}:${a}`))
  if (todo.length === 0) continue
  const order = i % 2 === 0 ? todo : [...todo].reverse() // alternate which arm goes first
  const dir = path.join(args.work, args.lane, task.id)
  try {
    const prep = await prepareCheckout({ repo, parent: task.parent, dir })
    await writeTests(repo, task.sha, dir, task.tests)
    await git(dir, 'add', '--', ...task.tests)
    await git(dir, '-c', 'user.name=eval', '-c', 'user.email=eval@localhost', 'commit', '-qm', 'eval: tests for this task')
    console.log(`${task.id} prepared in ${Object.values(prep).reduce((a, b) => a + b, 0).toFixed(0)} s`)
    for (const arm of order) await runArm(task, arm, dir, order.indexOf(arm))
  } catch (err) {
    console.error(`${task.id}: ${err.message}`)
    fs.appendFileSync(path.join(outDir, 'errors.log'), `${new Date().toISOString()} ${task.id} ${err.stack}\n`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
console.log('lane done')
