import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createGitCli, type GitCli } from './git.js'

const execFileAsync = promisify(execFile)

async function gitCmd(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'git-test-'))
  await gitCmd(dir, ['init', '-b', 'main'])
  await gitCmd(dir, ['config', 'user.email', 'test@test.com'])
  await gitCmd(dir, ['config', 'user.name', 'Test User'])
  // Initial commit so HEAD exists
  await writeFile(join(dir, 'README.md'), '# Test')
  await gitCmd(dir, ['add', '.'])
  await gitCmd(dir, ['commit', '-m', 'initial commit'])
  return dir
}

describe('Git CLI Wrapper', () => {
  let repoDir: string
  let cli: GitCli

  beforeEach(async () => {
    repoDir = await initRepo()
    cli = createGitCli()
  })

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  it('gets status with branch, staged, modified, untracked', async () => {
    // Create an untracked file
    await writeFile(join(repoDir, 'untracked.txt'), 'hello')
    // Modify existing file
    await writeFile(join(repoDir, 'README.md'), '# Modified')
    // Stage a new file
    await writeFile(join(repoDir, 'staged.txt'), 'staged')
    await gitCmd(repoDir, ['add', 'staged.txt'])

    const status = await cli.status(repoDir)
    expect(status.branch).toBe('main')
    expect(status.staged).toHaveLength(1)
    expect(status.staged[0].path).toBe('staged.txt')
    expect(status.modified).toHaveLength(1)
    expect(status.modified[0].path).toBe('README.md')
    expect(status.untracked).toContain('untracked.txt')
  })

  it('parses ahead/behind from status', async () => {
    // Without a remote, ahead/behind should be 0
    const status = await cli.status(repoDir)
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
  })

  it('stages files', async () => {
    await writeFile(join(repoDir, 'new.txt'), 'new')
    await cli.stage(repoDir, ['new.txt'])
    const status = await cli.status(repoDir)
    expect(status.staged.some((f) => f.path === 'new.txt')).toBe(true)
    expect(status.untracked).not.toContain('new.txt')
  })

  it('unstages files', async () => {
    await writeFile(join(repoDir, 'new.txt'), 'new')
    await gitCmd(repoDir, ['add', 'new.txt'])
    await cli.unstage(repoDir, ['new.txt'])
    const status = await cli.status(repoDir)
    expect(status.staged.some((f) => f.path === 'new.txt')).toBe(false)
    expect(status.untracked).toContain('new.txt')
  })

  it('creates a commit with message', async () => {
    await writeFile(join(repoDir, 'file.txt'), 'content')
    await gitCmd(repoDir, ['add', 'file.txt'])
    const commit = await cli.commit(repoDir, 'test commit')
    expect(commit.hash).toHaveLength(40)
    expect(commit.shortHash).toBeTruthy()
    expect(commit.message).toBe('test commit')
    expect(commit.author).toBe('Test User')
    expect(commit.date).toBeTruthy()
  })

  it('pushes to remote', async () => {
    // Create a bare remote
    const remoteDir = await mkdtemp(join(tmpdir(), 'git-remote-'))
    await gitCmd(remoteDir, ['init', '--bare'])
    await gitCmd(repoDir, ['remote', 'add', 'origin', remoteDir])
    await gitCmd(repoDir, ['push', '-u', 'origin', 'main'])

    // Make a new commit and push via CLI
    await writeFile(join(repoDir, 'push.txt'), 'push')
    await gitCmd(repoDir, ['add', '.'])
    await gitCmd(repoDir, ['commit', '-m', 'push test'])
    await cli.push(repoDir)

    // Verify remote has the commit
    const remoteLog = await gitCmd(remoteDir, ['log', '--oneline'])
    expect(remoteLog).toContain('push test')

    await rm(remoteDir, { recursive: true, force: true })
  })

  it('pulls from remote', async () => {
    // Set up two clones
    const remoteDir = await mkdtemp(join(tmpdir(), 'git-remote-'))
    await gitCmd(remoteDir, ['init', '--bare'])
    await gitCmd(repoDir, ['remote', 'add', 'origin', remoteDir])
    await gitCmd(repoDir, ['push', '-u', 'origin', 'main'])

    // Clone to a second repo and push
    const clone2 = await mkdtemp(join(tmpdir(), 'git-clone2-'))
    await gitCmd(clone2, ['clone', remoteDir, '.'])
    await gitCmd(clone2, ['config', 'user.email', 'test@test.com'])
    await gitCmd(clone2, ['config', 'user.name', 'Test User'])
    await writeFile(join(clone2, 'pulled.txt'), 'pulled')
    await gitCmd(clone2, ['add', '.'])
    await gitCmd(clone2, ['commit', '-m', 'from clone2'])
    await gitCmd(clone2, ['push'])

    // Pull in original
    await cli.pull(repoDir)
    const log = await gitCmd(repoDir, ['log', '--oneline'])
    expect(log).toContain('from clone2')

    await rm(remoteDir, { recursive: true, force: true })
    await rm(clone2, { recursive: true, force: true })
  })

  it('lists branches', async () => {
    await gitCmd(repoDir, ['checkout', '-b', 'feature'])
    await gitCmd(repoDir, ['checkout', 'main'])
    const branches = await cli.branches(repoDir)
    expect(branches).toContain('main')
    expect(branches).toContain('feature')
  })

  it('creates a new branch', async () => {
    await cli.checkout(repoDir, 'new-branch', true)
    const branches = await cli.branches(repoDir)
    expect(branches).toContain('new-branch')
    const status = await cli.status(repoDir)
    expect(status.branch).toBe('new-branch')
  })

  it('switches branch', async () => {
    await gitCmd(repoDir, ['checkout', '-b', 'other'])
    await gitCmd(repoDir, ['checkout', 'main'])
    await cli.checkout(repoDir, 'other')
    const status = await cli.status(repoDir)
    expect(status.branch).toBe('other')
  })

  it('gets commit log with hash, message, author, date', async () => {
    await writeFile(join(repoDir, 'a.txt'), 'a')
    await gitCmd(repoDir, ['add', '.'])
    await gitCmd(repoDir, ['commit', '-m', 'second commit'])

    const log = await cli.log(repoDir, 5)
    expect(log.length).toBeGreaterThanOrEqual(2)
    expect(log[0].message).toBe('second commit')
    expect(log[0].hash).toHaveLength(40)
    expect(log[0].author).toBe('Test User')
    expect(log[0].date).toBeTruthy()
    expect(log[1].message).toBe('initial commit')
  })

  it('gets diff for a file', async () => {
    await writeFile(join(repoDir, 'README.md'), '# Changed content')
    const diffOutput = await cli.diff(repoDir, 'README.md')
    expect(diffOutput).toContain('Changed content')
    expect(diffOutput).toContain('diff --git')
  })

  it('handles renamed files in status', async () => {
    await writeFile(join(repoDir, 'original.txt'), 'content')
    await gitCmd(repoDir, ['add', 'original.txt'])
    await gitCmd(repoDir, ['commit', '-m', 'add original'])
    await gitCmd(repoDir, ['mv', 'original.txt', 'renamed.txt'])

    const status = await cli.status(repoDir)
    expect(status.staged.some((f) => f.status === 'renamed')).toBe(true)
    const renamed = status.staged.find((f) => f.status === 'renamed')
    expect(renamed?.path).toBe('renamed.txt')
    expect(renamed?.oldPath).toBe('original.txt')
  })
})
