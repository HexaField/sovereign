import { describe, it, expect } from 'vitest'
import { DEFAULT_AD4M_WAKE } from '@sovereign/core'
import { contextLines, renderTemplate, resolveWake, wakeText } from './wake-text.js'

const AT = '2026-11-23T12:05:03.406Z'
const mention = {
  address: 'msg://1',
  author: 'did:key:z6MkAlex',
  verified: true,
  timestamp: AT,
  via: 'mentions' as const,
  parents: ['channel://1'],
  ancestors: ['space://1']
}

describe('renderTemplate', () => {
  it('fills named placeholders', () => {
    expect(renderTemplate('{a} and {b}', { a: 'x', b: 'y' })).toBe('x and y')
  })

  it('drops a line whose placeholder is empty, keeps the others', () => {
    expect(renderTemplate('one\n[[two {a}]]\nthree', { a: '' })).toBe('one\nthree')
    expect(renderTemplate('one\n[[two {a}]]\nthree', { a: 'x' })).toBe('one\ntwo x\nthree')
  })

  it('drops a segment inside a line, not the line', () => {
    expect(renderTemplate('hi[[: "{a}"]]', { a: '' })).toBe('hi')
    expect(renderTemplate('hi[[: "{a}"]]', { a: 'yo' })).toBe('hi: "yo"')
  })

  it('keeps an unknown placeholder literal', () => {
    expect(renderTemplate('{a} {nope}', { a: 'x' })).toBe('x {nope}')
  })

  it('does not expand a placeholder written inside a value', () => {
    expect(renderTemplate('{a}', { a: '{b}', b: 'no' })).toBe('{b}')
  })

  it('lets a segment span lines', () => {
    expect(renderTemplate('[[Before:\n{c}]]', { c: 'l1\nl2' })).toBe('Before:\nl1\nl2')
    expect(renderTemplate('x\n[[Before:\n{c}]]', { c: '' })).toBe('x')
  })
})

describe('wakeText with the default template', () => {
  it('reads as it did before the template: header, item, provenance, parents, ancestors', () => {
    expect(wakeText(resolveWake(undefined), mention, 'Hex, join?', [])).toBe(
      [
        '[AD4M] You were mentioned: "Hex, join?"',
        'Item: msg://1',
        'By: did:key:z6MkAlex (signature verified)',
        `At: ${AT}`,
        'Matched by: a mention link',
        'Parents: channel://1',
        'Ancestors: space://1'
      ].join('\n')
    )
  })

  it('has no quote without a body, says unverified and unknown parents', () => {
    const text = wakeText(
      resolveWake(undefined),
      { ...mention, verified: false, parents: [], ancestors: undefined, via: 'text' },
      undefined,
      []
    )
    expect(text.split('\n')[0]).toBe('[AD4M] You were mentioned')
    expect(text).toContain('By: did:key:z6MkAlex (signature NOT verified)')
    expect(text).toContain('Matched by: your name or DID in the text; a mention link may also exist')
    expect(text).toContain('Parents: (unknown)')
    expect(text).not.toContain('Ancestors')
  })

  it('adds the preceding messages after the item, oldest first', () => {
    const text = wakeText(resolveWake(undefined), mention, 'b', [
      { author: 'did:key:z6MkBob', timestamp: '2026-11-23T12:04:39.840Z', text: 'first' },
      { author: 'did:key:z6MkAlex', timestamp: '2026-11-23T12:04:55.234Z', text: 'second' }
    ])
    expect(text.endsWith('Before it:\n…6MkBob 12:04:39: first\n…MkAlex 12:04:55: second')).toBe(true)
  })
})

describe('configured wake text', () => {
  it('a custom template and labels apply', () => {
    const wake = resolveWake({
      template: 'Ping {address} from {author}: {body} [{via}] {verified}',
      labels: { verified: 'ok', viaLink: 'link' }
    })
    expect(wakeText(wake, mention, 'hello', [])).toBe('Ping msg://1 from did:key:z6MkAlex: hello [link] ok')
  })

  it('a partial config keeps the other defaults', () => {
    const wake = resolveWake({ contextMessages: 2 })
    expect(wake.contextMessages).toBe(2)
    expect(wake.template).toBe(DEFAULT_AD4M_WAKE.template)
    expect(wake.labels).toEqual(DEFAULT_AD4M_WAKE.labels)
  })

  it('a custom context line and a pointer line', () => {
    const wake = resolveWake({
      template: '{body}\nThe quote may be cut off.\n[[{context}]]',
      contextLine: '{time} {text}'
    })
    expect(wakeText(wake, mention, 'b', [{ author: 'a', timestamp: AT, text: 't' }])).toBe(
      'b\nThe quote may be cut off.\n12:05:03 t'
    )
  })
})

describe('contextLines', () => {
  const wake = resolveWake(undefined)
  it('clips each message and collapses whitespace', () => {
    const [line] = contextLines(wake, [{ author: 'did:key:z6MkBob', timestamp: AT, text: `a\n  b ${'x'.repeat(300)}` }])
    expect(line.length).toBeLessThan(260)
    expect(line).toMatch(/^…6MkBob 12:05:03: a b x+…$/)
  })

  it('keeps the newest messages when the total goes over the cap', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      author: 'a',
      timestamp: AT,
      text: `m${i} ${'y'.repeat(190)}`
    }))
    const lines = contextLines(wake, msgs)
    expect(lines.length).toBeLessThan(20)
    expect(lines[lines.length - 1]).toContain('m19 ')
    expect(lines.join('\n').length).toBeLessThanOrEqual(1200)
  })
})
