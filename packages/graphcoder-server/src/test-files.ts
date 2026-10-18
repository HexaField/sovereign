// The test files of one checkout, with their cases: vitest/jest cases parsed
// with the TypeScript compiler, Rust test functions and `#[cfg(test)]` modules
// scanned from the text. Everything else counts as one test per file.

import ts from 'typescript'
import {
  isTestPath,
  rustTestCases,
  rustTestRanges,
  type GraphNode,
  type RepoFiles,
  type TestCase,
  type TestFile,
  type TestRanges
} from '@sovereign/graphcoder-core'

/** Files the TypeScript parser reads (TS, TSX, JS, JSX, and their module variants) */
const PARSEABLE = /\.[cm]?[jt]sx?$/

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** Literal titles verbatim; any other expression as its source text (the runtime name may differ) */
function titleOf(e: ts.Expression | undefined): string | null {
  if (!e) return null
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
  if (ts.isTemplateExpression(e)) return e.getText().slice(1, -1)
  return e.getText()
}

/** `it`, `it.skip`, `it.each(table)` → `it` */
function calleeBase(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return calleeBase(e.expression)
  if (ts.isCallExpression(e)) return calleeBase(e.expression)
  return null
}

const TEST_FNS = new Set(['it', 'test'])
const SUITE_FNS = new Set(['describe', 'suite'])

/**
 * Test cases of a vitest/jest file. Full names join enclosing `describe` titles with spaces, which is how vitest's
 * JSON reporter names them. Duplicate names in one file get a ` #2`, ` #3` suffix so ids stay unique.
 */
export function parseTestCases(path: string, text: string): TestCase[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path))
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const out: TestCase[] = []
  const seen = new Map<string, number>()
  const visit = (n: ts.Node, titles: string[], scopes: Array<[number, number]>) => {
    if (ts.isCallExpression(n)) {
      const base = calleeBase(n.expression)
      const isTest = base !== null && TEST_FNS.has(base)
      const isSuite = base !== null && SUITE_FNS.has(base)
      const title = titleOf(n.arguments[0])
      const cb = [...n.arguments].reverse().find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))
      if ((isTest || isSuite) && title !== null && cb) {
        const range: [number, number] = [lineOf(cb.getStart(sf)), lineOf(cb.getEnd())]
        if (isSuite) {
          ts.forEachChild(cb, (c) => visit(c, [...titles, title], [...scopes, range]))
        } else {
          const name = [...titles, title].join(' ')
          const k = (seen.get(name) ?? 0) + 1
          seen.set(name, k)
          const unique = k === 1 ? name : `${name} #${k}`
          out.push({ id: `${path}::${unique}`, file: path, name: unique, start: range[0], end: range[1], scopes })
        }
        return
      }
    }
    ts.forEachChild(n, (c) => visit(c, titles, scopes))
  }
  visit(sf, [], [])
  return out
}

/**
 * Test files and inline test code of an indexed checkout, from its file nodes: a test-path JS/TS file gets its
 * parsed cases, a Rust file its test functions and `#[cfg(test)]` ranges, any other test-path file counts as one
 * test. A file that no longer reads, or does not parse, counts as one test too.
 */
export async function readTestFiles(
  files: RepoFiles,
  nodes: readonly GraphNode[]
): Promise<{ testFiles: TestFile[]; testRanges: TestRanges }> {
  const testFiles: TestFile[] = []
  const testRanges: TestRanges = new Map()
  const paths = [...new Set(nodes.filter((n) => n.kind === 'file').map((n) => n.filePath))].sort()
  for (const path of paths) {
    const testPath = isTestPath(path)
    if (path.endsWith('.rs')) {
      const text = await files.read(path)
      if (text === null || !(testPath || text.includes('cfg(test)'))) continue
      const ranges = rustTestRanges(text)
      if (ranges.length > 0) testRanges.set(path, ranges)
      const cases = rustTestCases(path, text)
      if (testPath || cases.length > 0) testFiles.push({ file: path, cases })
      continue
    }
    if (!testPath) continue
    let cases: TestCase[] | null = null
    if (PARSEABLE.test(path)) {
      const text = await files.read(path)
      try {
        cases = text === null ? null : parseTestCases(path, text)
      } catch {
        cases = null
      }
    }
    testFiles.push({ file: path, cases })
  }
  return { testFiles, testRanges }
}
