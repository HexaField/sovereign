// Rust tests from source text: the inline `#[cfg(test)] mod … { }` blocks
// (test code inside a source file, which edge hygiene needs to know) and the
// test functions (`#[test]`, `#[tokio::test]`, …), which are the test cases.
// The index records neither: Rust attributes are not node decorators.

import type { TestCase } from './test-reach.js'

/** Offset → 1-based line */
function lineIndex(text: string): (offset: number) => number {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/**
 * Offset of the `}` closing the `{` at `open`, skipping comments (nested block comments too), strings, raw strings
 * and char literals; -1 when it never closes.
 */
export function matchingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      const nl = text.indexOf('\n', i)
      if (nl === -1) return -1
      i = nl
    } else if (c === '/' && next === '*') {
      let nest = 1
      i += 2
      while (i < text.length && nest > 0) {
        const pair = text.slice(i, i + 2)
        if (pair === '/*' || pair === '*/') {
          nest += pair === '/*' ? 1 : -1
          i++
        }
        i++
      }
      i--
    } else if (c === 'r' && (next === '"' || next === '#') && !/[\w]/.test(text[i - 1] ?? '')) {
      const m = /^r(#*)"/.exec(text.slice(i, i + 260))
      if (!m) continue
      const close = text.indexOf(`"${m[1]}`, i + m[0].length)
      if (close === -1) return -1
      i = close + m[1].length
    } else if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    } else if (c === "'") {
      // A char literal ('a', '\n', '\u{1F600}'); otherwise a lifetime ('a), which has no closing quote
      if (next === '\\') {
        const close = text.indexOf("'", i + 2)
        if (close !== -1) i = close
      } else if (text[i + 2] === "'") i += 2
    } else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/** 1-based line ranges of `#[cfg(test)]` modules with a body */
export function rustTestRanges(text: string): Array<[number, number]> {
  const lineOf = lineIndex(text)
  const out: Array<[number, number]> = []
  const re = /#\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = m.index + m[0].length - 1
    const close = matchingBrace(text, open)
    if (close === -1) continue
    out.push([lineOf(m.index), lineOf(close)])
    re.lastIndex = close
  }
  return out
}

/** `#[test]`, `#[tokio::test]`, `#[tokio::test(flavor = "multi_thread")]`, `#[rstest]`, `#[test_case(…)]`, … */
const TEST_ATTR = /^#\[\s*(?:\w+::)*(?:test|rstest|test_case|wasm_bindgen_test)\b/

/**
 * Test functions of a Rust file: every `fn` with a test attribute among the attributes right above it, as callable
 * test cases from the attribute to the closing brace. Duplicate names get ` #2`, ` #3`.
 */
export function rustTestCases(path: string, text: string): TestCase[] {
  const lineOf = lineIndex(text)
  const out: TestCase[] = []
  const seen = new Map<string, number>()
  const re =
    /((?:#\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]\s*)+)(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const attrs = m[1].split(/(?=#\[)/).map((a) => a.trim())
    if (!attrs.some((a) => TEST_ATTR.test(a))) continue
    const bodyAt = text.slice(m.index + m[0].length).search(/[{;]/)
    if (bodyAt === -1 || text[m.index + m[0].length + bodyAt] !== '{') continue
    const close = matchingBrace(text, m.index + m[0].length + bodyAt)
    if (close === -1) continue
    const k = (seen.get(m[2]) ?? 0) + 1
    seen.set(m[2], k)
    const name = k === 1 ? m[2] : `${m[2]} #${k}`
    out.push({
      id: `${path}::${name}`,
      file: path,
      name,
      start: lineOf(m.index),
      end: lineOf(close),
      scopes: [],
      callable: true
    })
    re.lastIndex = close
  }
  return out
}
