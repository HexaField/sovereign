import { describe, it, expect } from 'vitest'
import { parseDiff, countAdditions, countDeletions } from './diff-parser.js'
import { pairLinesForSplit } from './DiffViewer.js'

describe('parseDiff', () => {
  it('parses a simple single-file diff', () => {
    const raw = `diff --git a/src/main.ts b/src/main.ts
index abc1234..def5678 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,4 +1,5 @@
 import { foo } from './foo'
-import { bar } from './bar'
+import { bar } from './bar2'
+import { baz } from './baz'

 function main() {`

    const result = parseDiff(raw)
    expect(result).toHaveLength(1)
    expect(result[0].from).toBe('src/main.ts')
    expect(result[0].to).toBe('src/main.ts')
    expect(result[0].binary).toBe(false)
    expect(result[0].hunks).toHaveLength(1)

    const hunk = result[0].hunks[0]
    expect(hunk.oldStart).toBe(1)
    expect(hunk.oldCount).toBe(4)
    expect(hunk.newStart).toBe(1)
    expect(hunk.newCount).toBe(5)

    const addLines = hunk.lines.filter((l) => l.type === 'add')
    const delLines = hunk.lines.filter((l) => l.type === 'del')
    const ctxLines = hunk.lines.filter((l) => l.type === 'context')
    expect(addLines).toHaveLength(2)
    expect(delLines).toHaveLength(1)
    expect(ctxLines).toHaveLength(3)
  })

  it('parses multiple files', () => {
    const raw = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 line1
+added
 line2
diff --git a/b.ts b/b.ts
index 333..444 100644
--- a/b.ts
+++ b/b.ts
@@ -1,3 +1,2 @@
 keep
-removed
 also keep`

    const result = parseDiff(raw)
    expect(result).toHaveLength(2)
    expect(result[0].to).toBe('a.ts')
    expect(result[1].to).toBe('b.ts')
  })

  it('handles multiple hunks in one file', () => {
    const raw = `diff --git a/file.ts b/file.ts
index aaa..bbb 100644
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 a
+b
 c
 d
@@ -10,3 +11,4 @@
 x
+y
 z
 w`

    const result = parseDiff(raw)
    expect(result).toHaveLength(1)
    expect(result[0].hunks).toHaveLength(2)
    expect(result[0].hunks[0].oldStart).toBe(1)
    expect(result[0].hunks[1].oldStart).toBe(10)
  })

  it('detects binary files', () => {
    const raw = `diff --git a/image.png b/image.png
index 000..111 100644
Binary files a/image.png and b/image.png differ`

    const result = parseDiff(raw)
    expect(result).toHaveLength(1)
    expect(result[0].binary).toBe(true)
    expect(result[0].hunks).toHaveLength(0)
  })

  it('detects renamed files', () => {
    const raw = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
index aaa..bbb 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
 line1
-line2
+line2-changed
 line3`

    const result = parseDiff(raw)
    expect(result).toHaveLength(1)
    expect(result[0].renamed).toBe(true)
    expect(result[0].from).toBe('old-name.ts')
    expect(result[0].to).toBe('new-name.ts')
  })

  it('assigns correct line numbers', () => {
    const raw = `diff --git a/f.ts b/f.ts
index aaa..bbb 100644
--- a/f.ts
+++ b/f.ts
@@ -5,4 +5,5 @@ function foo() {
 context
-deleted
+added1
+added2
 end`

    const result = parseDiff(raw)
    const lines = result[0].hunks[0].lines
    // context line: old=5, new=5
    expect(lines[0]).toMatchObject({ type: 'context', oldLine: 5, newLine: 5 })
    // deleted line: old=6, no new
    expect(lines[1]).toMatchObject({ type: 'del', oldLine: 6 })
    expect(lines[1].newLine).toBeUndefined()
    // added lines: no old, new=6,7
    expect(lines[2]).toMatchObject({ type: 'add', newLine: 6 })
    expect(lines[2].oldLine).toBeUndefined()
    expect(lines[3]).toMatchObject({ type: 'add', newLine: 7 })
    // end context: old=7, new=8
    expect(lines[4]).toMatchObject({ type: 'context', oldLine: 7, newLine: 8 })
  })

  it('handles empty input', () => {
    expect(parseDiff('')).toEqual([])
    expect(parseDiff('   ')).toEqual([])
  })

  it('handles "no newline at end of file" marker', () => {
    const raw = `diff --git a/f.ts b/f.ts
index aaa..bbb 100644
--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,2 @@
 line1
-line2
\\ No newline at end of file
+line2-new
\\ No newline at end of file`

    const result = parseDiff(raw)
    const headerLines = result[0].hunks[0].lines.filter((l) => l.type === 'header')
    expect(headerLines).toHaveLength(2)
  })
})

describe('countAdditions', () => {
  it('counts additions across hunks', () => {
    const raw = `diff --git a/f.ts b/f.ts
index aaa..bbb 100644
--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,4 @@
 ctx
+add1
+add2
 ctx2
@@ -10,2 +12,3 @@
 x
+add3
 y`

    const file = parseDiff(raw)[0]
    expect(countAdditions(file)).toBe(3)
  })
})

describe('countDeletions', () => {
  it('counts deletions across hunks', () => {
    const raw = `diff --git a/f.ts b/f.ts
index aaa..bbb 100644
--- a/f.ts
+++ b/f.ts
@@ -1,4 +1,2 @@
 ctx
-del1
-del2
 ctx2`

    const file = parseDiff(raw)[0]
    expect(countDeletions(file)).toBe(2)
  })
})

describe('pairLinesForSplit', () => {
  it('pairs context lines on both sides', () => {
    const pairs = pairLinesForSplit([
      { type: 'context', content: 'hello', oldLine: 1, newLine: 1 },
      { type: 'context', content: 'world', oldLine: 2, newLine: 2 }
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs[0].left).toEqual(pairs[0].right)
    expect(pairs[1].left).toEqual(pairs[1].right)
  })

  it('pairs matching del/add lines side-by-side', () => {
    const pairs = pairLinesForSplit([
      { type: 'del', content: 'old line', oldLine: 5 },
      { type: 'add', content: 'new line', newLine: 5 }
    ])
    expect(pairs).toHaveLength(1)
    expect(pairs[0].left!.type).toBe('del')
    expect(pairs[0].left!.content).toBe('old line')
    expect(pairs[0].right!.type).toBe('add')
    expect(pairs[0].right!.content).toBe('new line')
  })

  it('fills null for unpaired deletions', () => {
    const pairs = pairLinesForSplit([
      { type: 'del', content: 'removed1', oldLine: 1 },
      { type: 'del', content: 'removed2', oldLine: 2 }
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs[0].left!.content).toBe('removed1')
    expect(pairs[0].right).toBeNull()
    expect(pairs[1].left!.content).toBe('removed2')
    expect(pairs[1].right).toBeNull()
  })

  it('fills null for unpaired additions', () => {
    const pairs = pairLinesForSplit([
      { type: 'add', content: 'added1', newLine: 1 },
      { type: 'add', content: 'added2', newLine: 2 }
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs[0].left).toBeNull()
    expect(pairs[0].right!.content).toBe('added1')
    expect(pairs[1].left).toBeNull()
    expect(pairs[1].right!.content).toBe('added2')
  })

  it('handles more dels than adds in a change block', () => {
    const pairs = pairLinesForSplit([
      { type: 'del', content: 'old1', oldLine: 1 },
      { type: 'del', content: 'old2', oldLine: 2 },
      { type: 'del', content: 'old3', oldLine: 3 },
      { type: 'add', content: 'new1', newLine: 1 }
    ])
    expect(pairs).toHaveLength(3)
    expect(pairs[0].left!.content).toBe('old1')
    expect(pairs[0].right!.content).toBe('new1')
    expect(pairs[1].left!.content).toBe('old2')
    expect(pairs[1].right).toBeNull()
    expect(pairs[2].left!.content).toBe('old3')
    expect(pairs[2].right).toBeNull()
  })

  it('handles more adds than dels in a change block', () => {
    const pairs = pairLinesForSplit([
      { type: 'del', content: 'old', oldLine: 1 },
      { type: 'add', content: 'new1', newLine: 1 },
      { type: 'add', content: 'new2', newLine: 2 },
      { type: 'add', content: 'new3', newLine: 3 }
    ])
    expect(pairs).toHaveLength(3)
    expect(pairs[0].left!.content).toBe('old')
    expect(pairs[0].right!.content).toBe('new1')
    expect(pairs[1].left).toBeNull()
    expect(pairs[1].right!.content).toBe('new2')
    expect(pairs[2].left).toBeNull()
    expect(pairs[2].right!.content).toBe('new3')
  })

  it('handles interleaved context and changes', () => {
    const pairs = pairLinesForSplit([
      { type: 'context', content: 'before', oldLine: 1, newLine: 1 },
      { type: 'del', content: 'removed', oldLine: 2 },
      { type: 'add', content: 'replaced', newLine: 2 },
      { type: 'context', content: 'after', oldLine: 3, newLine: 3 }
    ])
    expect(pairs).toHaveLength(3)
    expect(pairs[0].left!.type).toBe('context')
    expect(pairs[1].left!.type).toBe('del')
    expect(pairs[1].right!.type).toBe('add')
    expect(pairs[2].left!.type).toBe('context')
  })

  it('handles empty input', () => {
    expect(pairLinesForSplit([])).toEqual([])
  })
})
