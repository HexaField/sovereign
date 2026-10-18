import { describe, expect, it } from 'vitest'
import { hunkLines, parseUnifiedDiff } from './unified-diff.js'

const DIFF = `diff --git a/src/math.ts b/src/math.ts
index 1111111..2222222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -3 +3 @@ export function add(a: number, b: number) {
-  return a + b
+  return b + a
@@ -9,0 +10,4 @@ export function sub(a: number, b: number) {
+export function mul(a: number, b: number) {
+  return a * b
+}
+
@@ -20,2 +24,0 @@
--- a line that looks like a header
-gone
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1
+export const y = 2
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const z = 3
diff --git a/src/a.ts b/src/moved/a.ts
similarity index 100%
rename from src/a.ts
rename to src/moved/a.ts
diff --git a/src/b.ts b/lib/b.ts
similarity index 80%
rename from src/b.ts
rename to lib/b.ts
index 5555555..6666666 100644
--- a/src/b.ts
+++ b/lib/b.ts
@@ -2 +2 @@
-old
+new
diff --git a/img/logo.png b/img/logo.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/img/logo.png differ
diff --git "a/src/t\\303\\244b.ts" "b/src/t\\303\\244b.ts"
index 8888888..9999999 100644
--- "a/src/t\\303\\244b.ts"
+++ "b/src/t\\303\\244b.ts"
@@ -1 +1 @@
-a
+b
`

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(DIFF)
  const byPath = new Map(files.map((f) => [f.path, f]))

  it('reads every file once, in diff order', () => {
    expect(files.map((f) => f.path)).toEqual([
      'src/math.ts',
      'src/new.ts',
      'src/old.ts',
      'src/moved/a.ts',
      'lib/b.ts',
      'img/logo.png',
      'src/täb.ts'
    ])
  })

  it('reads hunk headers, with an omitted count meaning one line', () => {
    expect(byPath.get('src/math.ts')).toEqual({
      path: 'src/math.ts',
      status: 'modified',
      hunks: [
        { baseStart: 3, baseLines: 1, headStart: 3, headLines: 1 },
        { baseStart: 9, baseLines: 0, headStart: 10, headLines: 4 },
        { baseStart: 20, baseLines: 2, headStart: 24, headLines: 0 }
      ]
    })
  })

  it('tells added, deleted and renamed files apart', () => {
    expect(byPath.get('src/new.ts')!.status).toBe('added')
    expect(byPath.get('src/old.ts')).toMatchObject({ status: 'deleted', hunks: [{ baseStart: 1, headLines: 0 }] })
    expect(byPath.get('src/moved/a.ts')).toEqual({
      path: 'src/moved/a.ts',
      status: 'renamed',
      oldPath: 'src/a.ts',
      hunks: []
    })
    expect(byPath.get('lib/b.ts')).toMatchObject({ status: 'renamed', oldPath: 'src/b.ts', hunks: [{ headStart: 2 }] })
  })

  it('keeps a binary file with no hunks, and unquotes octal-escaped paths', () => {
    expect(byPath.get('img/logo.png')).toEqual({ path: 'img/logo.png', status: 'added', hunks: [] })
    expect(byPath.get('src/täb.ts')!.hunks).toHaveLength(1)
  })

  it('reads an empty diff as no files', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
})

describe('hunkLines', () => {
  it('covers start..start+count-1, and nothing for an empty side', () => {
    expect(hunkLines(10, 4)).toEqual([10, 13])
    expect(hunkLines(9, 0)).toBeNull()
  })
})
