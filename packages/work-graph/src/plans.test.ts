import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPlanPath, planRefs, planStatus, planTitle, scanPlans } from './plans.js'

describe('plan parsing', () => {
  it('takes the title from the first heading, else the file name', () => {
    expect(planTitle('intro\n\n## Sprocket rework\n\n# Later', 'x')).toBe('Sprocket rework')
    expect(planTitle('no headings', 'fallback')).toBe('fallback')
  })

  it('reads Status: lines in their usual shapes', () => {
    expect(planStatus('# P\n\nStatus: done')).toBe('done')
    expect(planStatus('*Plan, 2026-10-01. Status: shipped in v2.*')).toBe('done')
    expect(planStatus('**Status:** in progress')).toBe('in_progress')
    expect(planStatus('Status: plan, nothing built.')).toBe('planned')
    expect(planStatus('# No status')).toBe('planned')
  })

  it('links full URLs and owner/repo#N always', () => {
    const refs = planRefs('See https://github.com/acme-labs/widget/pull/12 and acme-labs/gadget#7 and #3.')
    expect(refs).toEqual([
      { host: 'github.com', repo: 'acme-labs/widget', number: 12, kind: 'change' },
      { host: 'github.com', repo: 'acme-labs/gadget', number: 7 }
    ])
  })

  it('links a bare #N only when the file names exactly one repo', () => {
    expect(planRefs('Fix #4 and #5 in acme-labs/widget.', ['acme-labs/widget'])).toEqual([
      { host: 'github.com', repo: 'acme-labs/widget', number: 4 },
      { host: 'github.com', repo: 'acme-labs/widget', number: 5 }
    ])
    // Two repos named: bare numbers are ambiguous.
    const two = planRefs('acme-labs/widget and acme-labs/gadget; then #4.', ['acme-labs/widget', 'acme-labs/gadget'])
    expect(two).toEqual([])
    // An item reference names that item, not the file's repo.
    expect(planRefs('Covers #50 and acme-labs/gadget#9.', ['acme-labs/widget', 'acme-labs/gadget'])).toEqual([
      { host: 'github.com', repo: 'acme-labs/gadget', number: 9 }
    ])
    // No repo named at all.
    expect(planRefs('Then #4.', ['acme-labs/widget'])).toEqual([])
    // A Repo: line decides.
    expect(
      planRefs('Repo: acme-labs/gadget\n\nalso acme-labs/widget#1, then #9', ['acme-labs/widget', 'acme-labs/gadget'])
    ).toContainEqual({
      host: 'github.com',
      repo: 'acme-labs/gadget',
      number: 9
    })
  })

  it('ignores #N inside fenced code and anchors in URLs', () => {
    const text = 'acme-labs/widget\n\n```\nwidget#1 #2\n```\n\nhttps://example.org/page#3'
    expect(planRefs(text, ['acme-labs/widget'])).toEqual([])
  })
})

describe('scanPlans', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-plans-'))
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('makes one plan per markdown file, nested dirs included, a file under two dirs once', () => {
    fs.mkdirSync(path.join(tmp, 'plans', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'plans', 'a.md'), '# Alpha\n\nStatus: done\n\nacme-labs/widget#1')
    fs.writeFileSync(path.join(tmp, 'plans', 'sub', 'b.md'), '# Beta\n\nCovers #8.')
    fs.writeFileSync(path.join(tmp, 'plans', 'notes.txt'), 'not a plan')
    const dirs = [
      { dir: path.join(tmp, 'plans'), project: 'acme/widget', repo: 'acme-labs/widget' },
      { dir: path.join(tmp, 'plans', 'sub'), project: 'acme/other' }
    ]
    const plans = scanPlans(dirs, ['acme-labs/widget', 'acme-labs/gadget']).sort((x, y) => x.id.localeCompare(y.id))
    expect(plans.map((p) => p.id)).toEqual(['plan:acme/widget/a.md', 'plan:acme/widget/sub/b.md'])
    expect(plans[0]).toMatchObject({ title: 'Alpha', status: 'done', refs: [{ repo: 'acme-labs/widget', number: 1 }] })
    // b.md names no repo: its bare #8 does not link.
    expect(plans[1].refs).toEqual([])
    expect(isPlanPath(dirs, path.join(tmp, 'plans', 'sub', 'b.md'))).toBe(true)
    expect(isPlanPath(dirs, path.join(tmp, 'plans', 'notes.txt'))).toBe(false)
    expect(isPlanPath(dirs, path.join(tmp, 'elsewhere.md'))).toBe(false)
  })
})
