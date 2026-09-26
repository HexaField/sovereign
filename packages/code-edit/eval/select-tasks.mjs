#!/usr/bin/env node
// Pick evaluation tasks from a repo's history. A task is a commit that
// changes 1–3 source files (≤ maxLines changed lines) plus at least one test,
// and nothing outside packages/*/src except docs. It qualifies when its tests,
// dropped onto the parent commit, fail — and pass once the commit's source
// change is applied.
//
//   node select-tasks.mjs --repo <path> [--since 2026-08-01] [--count 20] [--out tasks.json]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { git, prepareCheckout, runTests, sh, taskFiles, writeTests } from './lib.mjs'

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    since: { type: 'string', default: '2026-08-01' },
    count: { type: 'string', default: '20' },
    'max-lines': { type: 'string', default: '80' },
    out: { type: 'string', default: 'tasks.json' },
    work: { type: 'string', default: path.join(os.homedir(), '.cache', 'symbol-edit-eval', 'select') }
  }
})
if (!args.repo) throw new Error('--repo is required')
const repo = path.resolve(args.repo)
const want = Number(args.count)
const maxLines = Number(args['max-lines'])
const DOCS = /(^|\/)(AGENTS|README|CHANGELOG|CLAUDE)\.md$/

async function candidates() {
  const shas = (await git(repo, 'log', '--no-merges', `--since=${args.since}`, '--format=%H', 'HEAD')).split('\n').filter(Boolean)
  const out = []
  for (const sha of shas) {
    const numstat = (await git(repo, 'diff-tree', '--no-commit-id', '-r', '--numstat', sha)).split('\n').filter(Boolean)
    const rows = numstat.map((l) => l.split('\t')).map(([a, d, f]) => ({ lines: Number(a) + Number(d), f }))
    const { tests, src } = await taskFiles(repo, sha)
    const lines = rows.filter((r) => src.includes(r.f)).reduce((n, r) => n + r.lines, 0)
    const other = rows.filter((r) => !src.includes(r.f) && !tests.includes(r.f) && !DOCS.test(r.f) && !r.f.endsWith('pnpm-lock.yaml'))
    if (src.length >= 1 && src.length <= 3 && lines <= maxLines && tests.length >= 1 && other.length === 0) {
      out.push({ sha, tests, src, lines })
    }
  }
  return out
}

const tasks = fs.existsSync(args.out) ? JSON.parse(fs.readFileSync(args.out, 'utf8')) : []
const rejectedFile = args.out.replace(/\.json$/, '.rejected.json')
const rejected = fs.existsSync(rejectedFile) ? JSON.parse(fs.readFileSync(rejectedFile, 'utf8')) : []
const done = new Set(tasks.map((t) => t.sha))
const skip = (sha) => done.has(sha) || rejected.some((r) => sha.startsWith(r.sha))
for (const c of await candidates()) {
  if (tasks.length >= want) break
  if (skip(c.sha)) continue
  const parent = (await git(repo, 'rev-parse', `${c.sha}^`)).trim()
  const dir = path.join(args.work, c.sha.slice(0, 10))
  const started = Date.now()
  try {
    await prepareCheckout({ repo, parent, dir })
    await writeTests(repo, c.sha, dir, c.tests)
    const before = await runTests(dir, c.tests)
    if (before.pass) throw new Error(`tests already pass at the parent (${before.summary})`)
    const diff = await git(repo, 'diff', parent, c.sha, '--', ...c.src)
    const applied = await sh('git', ['apply'], { cwd: dir, input: diff })
    if (applied.code !== 0) throw new Error(`fix does not apply: ${applied.stderr}`)
    const after = await runTests(dir, c.tests)
    if (!after.pass) throw new Error(`tests still fail with the fix (${after.summary})`)
    const subject = (await git(repo, 'log', '-1', '--format=%s', c.sha)).trim()
    const body = (await git(repo, 'log', '-1', '--format=%b', c.sha)).trim()
    tasks.push({ id: c.sha.slice(0, 8), sha: c.sha, parent, subject, body, tests: c.tests, src: c.src, lines: c.lines, failingBefore: before.summary })
    fs.writeFileSync(args.out, JSON.stringify(tasks, null, 2) + '\n')
    console.log(`✓ ${c.sha.slice(0, 8)} ${subject.slice(0, 70)} (${((Date.now() - started) / 1000).toFixed(0)} s)`)
  } catch (err) {
    rejected.push({ sha: c.sha.slice(0, 8), reason: String(err.message).split('\n')[0].slice(0, 160) })
    console.log(`✗ ${c.sha.slice(0, 8)} ${rejected.at(-1).reason}`)
    fs.writeFileSync(rejectedFile, JSON.stringify(rejected, null, 2) + '\n')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
console.log(`${tasks.length} tasks, ${rejected.length} rejected → ${args.out}`)
