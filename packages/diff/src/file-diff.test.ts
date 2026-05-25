import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { diffFile, diffWorking } from './file-diff.js'

let tmpDir: string

function git(cmd: string) {
  execSync(`git ${cmd}`, {
    cwd: tmpDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com'
    }
  })
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-test-'))
  git('init')
  git('-c user.name=Test -c user.email=test@test.com commit --allow-empty -m "init"')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('diffFile', () => {
  describe('diff between commits', () => {
    it('returns FileDiff for a modified file between two commits', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello\n')
      git('add -A')
      git('-c user.name=Test -c user.email=test@test.com commit -m "add a"')
      const base = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim()

      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'world\n')
      git('add -A')
      git('-c user.name=Test -c user.email=test@test.com commit -m "modify a"')
      const head = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim()

      const result = await diffFile(tmpDir, 'a.txt', base, head)
      expect(result.path).toBe('a.txt')
      expect(result.status).toBe('modified')
      expect(result.additions).toBeGreaterThan(0)
      expect(result.deletions).toBeGreaterThan(0)
    })

    it('returns FileDiff for an added file', async () => {
      const base = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim()
      fs.writeFileSync(path.join(tmpDir, 'new.txt'), 'content\n')
      git('add -A')
      git('-c user.name=Test -c user.email=test@test.com commit -m "add new"')
      const head = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim()

      const result = await diffFile(tmpDir, 'new.txt', base, head)
      expect(result.status).toBe('added')
      expect(result.additions).toBeGreaterThan(0)
    })

    it('returns FileDiff for a deleted file', async () => {
      fs.writeFileSync(path.join(tmpDir, 'del.txt'), 'content\n')
      git('add -A')
      git('-c user.name=Test -c user.email=test@test.com commit -m "add del"')
      const base = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim()

      fs.unlinkSync(path.join(tmpDir, 'del.txt'))
      git('add -A')
      git('-c user.name=Test -c user.email=test@test.com commit -m "del"')
      const head = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim()

      const result = await diffFile(tmpDir, 'del.txt', base, head)
      expect(result.status).toBe('deleted')
    })

    it('includes correct additions and deletions counts', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'line1\nline2\nline3\n')
      git('add -A')
      git('-c user.name=Test -c user.email=test@test.com commit -m "add"')
      const base = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim()

      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'line1\nchanged\nline3\nnew\n')
      git('add -A')
      git('-c user.name=Test -c user.email=test@test.com commit -m "modify"')
      const head = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim()

      const result = await diffFile(tmpDir, 'a.txt', base, head)
      expect(result.additions).toBe(2)
      expect(result.deletions).toBe(1)
    })

    it('reports binary files as binary with no line diff', async () => {
      fs.writeFileSync(path.join(tmpDir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
      git('add -A')
      git('-c user.name=Test -c user.email=test@test.com commit -m "add bin"')
      const base = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim()

      fs.writeFileSync(path.join(tmpDir, 'bin.dat'), Buffer.from([0xff, 0xfe, 0xfd]))
      git('add -A')
      git('-c user.name=Test -c user.email=test@test.com commit -m "mod bin"')
      const head = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim()

      const result = await diffFile(tmpDir, 'bin.dat', base, head)
      expect(result.binary).toBe(true)
      expect(result.hunks).toEqual([])
    })
  })

  describe('working tree diff', () => {
    it('returns unstaged changes (HEAD vs working tree)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello\n')
      git('add -A')
      git('-c user.name=Test -c user.email=test@test.com commit -m "add"')

      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'modified\n')
      const result = await diffWorking(tmpDir)
      expect(result.length).toBeGreaterThan(0)
      expect(result[0].path).toBe('a.txt')
    })

    it('returns staged changes when opts.staged is true', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello\n')
      git('add -A')
      git('-c user.name=Test -c user.email=test@test.com commit -m "add"')

      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'staged\n')
      git('add -A')
      const result = await diffWorking(tmpDir, { staged: true })
      expect(result.length).toBeGreaterThan(0)
    })

    it('returns multiple FileDiffs for multiple changed files', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a\n')
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b\n')
      git('add -A')
      git('-c user.name=Test -c user.email=test@test.com commit -m "add"')

      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'aa\n')
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'bb\n')
      const result = await diffWorking(tmpDir)
      expect(result.length).toBe(2)
    })
  })
})
