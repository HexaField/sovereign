import { describe, it, expect, vi } from 'vitest'
import { extractPaths, createRepoTracker } from './repo-tracker.js'
import type { GitCli } from './git.js'

describe('extractPaths', () => {
  it('extracts file_path from Read tool', () => {
    const paths = extractPaths('Read', JSON.stringify({ file_path: '/home/user/project/src/app.ts' }))
    expect(paths).toEqual(['/home/user/project/src/app.ts'])
  })

  it('extracts file_path from Edit tool', () => {
    const paths = extractPaths(
      'Edit',
      JSON.stringify({ file_path: '/home/user/project/lib.ts', old_string: 'a', new_string: 'b' })
    )
    expect(paths).toEqual(['/home/user/project/lib.ts'])
  })

  it('extracts file_path from Write tool', () => {
    const paths = extractPaths('Write', JSON.stringify({ file_path: '/tmp/test.ts', content: 'hello' }))
    expect(paths).toEqual(['/tmp/test.ts'])
  })

  it('extracts path from Grep tool', () => {
    const paths = extractPaths('Grep', JSON.stringify({ pattern: 'foo', path: '/home/user/project' }))
    expect(paths).toEqual(['/home/user/project'])
  })

  it('extracts path from Glob tool', () => {
    const paths = extractPaths('Glob', JSON.stringify({ pattern: '**/*.ts', path: '/home/user/project/src' }))
    expect(paths).toEqual(['/home/user/project/src'])
  })

  it('extracts cd paths from Bash tool', () => {
    const paths = extractPaths('Bash', JSON.stringify({ command: 'cd /home/user/project && npm test' }))
    expect(paths).toContain('/home/user/project')
  })

  it('extracts absolute arg paths from Bash tool', () => {
    const paths = extractPaths('Bash', JSON.stringify({ command: 'cat /home/user/project/README.md' }))
    expect(paths).toContainEqual('/home/user/project/README.md')
  })

  it('extracts projectPath from codegraph tool', () => {
    const paths = extractPaths(
      'mcp__codegraph__codegraph_explore',
      JSON.stringify({ query: 'foo', projectPath: '/home/user/project' })
    )
    expect(paths).toEqual(['/home/user/project'])
  })

  it('extracts repo from semble tool', () => {
    const paths = extractPaths('mcp__semble__search', JSON.stringify({ query: 'auth', repo: '/home/user/project' }))
    expect(paths).toEqual(['/home/user/project'])
  })

  it('ignores relative paths', () => {
    const paths = extractPaths('Read', JSON.stringify({ file_path: 'relative/path.ts' }))
    expect(paths).toEqual([])
  })

  it('returns empty for unknown tools', () => {
    const paths = extractPaths('UnknownTool', JSON.stringify({ some: 'data' }))
    expect(paths).toEqual([])
  })

  it('returns empty for undefined input', () => {
    expect(extractPaths('Read', undefined)).toEqual([])
    expect(extractPaths(undefined, '{"file_path":"/a"}')).toEqual([])
  })

  it('returns empty for invalid JSON', () => {
    expect(extractPaths('Read', 'not json')).toEqual([])
  })
})

describe('createRepoTracker', () => {
  function mockGitCli(repoRootFn: (cwd: string) => Promise<string | null>): GitCli {
    return { repoRoot: repoRootFn } as unknown as GitCli
  }

  it('tracks repos from tool calls', async () => {
    const cli = mockGitCli(async (cwd) => {
      if (cwd.startsWith('/home/user/project')) return '/home/user/project'
      return null
    })
    const tracker = createRepoTracker(cli)

    await tracker.trackWorkItem('thread-1', 'Read', JSON.stringify({ file_path: '/home/user/project/src/app.ts' }))
    expect(tracker.getRepos('thread-1')).toEqual(['/home/user/project'])
  })

  it('deduplicates repos within a thread', async () => {
    const cli = mockGitCli(async () => '/home/user/project')
    const tracker = createRepoTracker(cli)

    await tracker.trackWorkItem('t1', 'Read', JSON.stringify({ file_path: '/home/user/project/a.ts' }))
    await tracker.trackWorkItem(
      't1',
      'Edit',
      JSON.stringify({ file_path: '/home/user/project/b.ts', old_string: '', new_string: '' })
    )
    expect(tracker.getRepos('t1')).toEqual(['/home/user/project'])
  })

  it('tracks multiple repos per thread', async () => {
    const cli = mockGitCli(async (cwd) => {
      if (cwd.startsWith('/home/user/alpha')) return '/home/user/alpha'
      if (cwd.startsWith('/home/user/beta')) return '/home/user/beta'
      return null
    })
    const tracker = createRepoTracker(cli)

    await tracker.trackWorkItem('t1', 'Read', JSON.stringify({ file_path: '/home/user/alpha/a.ts' }))
    await tracker.trackWorkItem('t1', 'Read', JSON.stringify({ file_path: '/home/user/beta/b.ts' }))

    const repos = tracker.getRepos('t1')
    expect(repos).toHaveLength(2)
    expect(repos).toContain('/home/user/alpha')
    expect(repos).toContain('/home/user/beta')
  })

  it('isolates repos across threads', async () => {
    const cli = mockGitCli(async (cwd) => {
      if (cwd.startsWith('/home/user/alpha')) return '/home/user/alpha'
      if (cwd.startsWith('/home/user/beta')) return '/home/user/beta'
      return null
    })
    const tracker = createRepoTracker(cli)

    await tracker.trackWorkItem('t1', 'Read', JSON.stringify({ file_path: '/home/user/alpha/a.ts' }))
    await tracker.trackWorkItem('t2', 'Read', JSON.stringify({ file_path: '/home/user/beta/b.ts' }))

    expect(tracker.getRepos('t1')).toEqual(['/home/user/alpha'])
    expect(tracker.getRepos('t2')).toEqual(['/home/user/beta'])
  })

  it('returns empty array for unknown thread', () => {
    const cli = mockGitCli(async () => null)
    const tracker = createRepoTracker(cli)
    expect(tracker.getRepos('nonexistent')).toEqual([])
  })

  it('skips paths not in any git repo', async () => {
    const cli = mockGitCli(async () => null)
    const tracker = createRepoTracker(cli)

    await tracker.trackWorkItem('t1', 'Read', JSON.stringify({ file_path: '/tmp/scratch.ts' }))
    expect(tracker.getRepos('t1')).toEqual([])
  })

  it('caches repo root lookups', async () => {
    const repoRootFn = vi.fn().mockResolvedValue('/home/user/project')
    const cli = mockGitCli(repoRootFn)
    const tracker = createRepoTracker(cli)

    await tracker.trackWorkItem('t1', 'Read', JSON.stringify({ file_path: '/home/user/project/src/a.ts' }))
    await tracker.trackWorkItem('t1', 'Read', JSON.stringify({ file_path: '/home/user/project/src/b.ts' }))

    // Same directory — should only call repoRoot once
    expect(repoRootFn).toHaveBeenCalledTimes(1)
  })

  it('ignores tool calls with no extractable paths', async () => {
    const repoRootFn = vi.fn()
    const cli = mockGitCli(repoRootFn)
    const tracker = createRepoTracker(cli)

    await tracker.trackWorkItem('t1', 'UnknownTool', JSON.stringify({ foo: 'bar' }))
    expect(repoRootFn).not.toHaveBeenCalled()
    expect(tracker.getRepos('t1')).toEqual([])
  })

  it('seeds from history log messages with tool_use content blocks', async () => {
    const cli = mockGitCli(async (cwd) => {
      if (cwd.startsWith('/home/user/project')) return '/home/user/project'
      return null
    })
    const tracker = createRepoTracker(cli)

    const messages = [
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/user/project/src/app.ts' } },
          { type: 'text', text: 'I read the file' }
        ]
      },
      { role: 'user', content: 'thanks' }
    ]

    await tracker.seedFromHistory('t1', messages)
    expect(tracker.getRepos('t1')).toEqual(['/home/user/project'])
    expect(tracker.hasSeeded('t1')).toBe(true)
  })

  it('seeds from history log messages with direct name+input fields', async () => {
    const cli = mockGitCli(async () => '/home/user/repo')
    const tracker = createRepoTracker(cli)

    const messages = [
      { name: 'Edit', input: JSON.stringify({ file_path: '/home/user/repo/lib.ts', old_string: 'a', new_string: 'b' }) }
    ]

    await tracker.seedFromHistory('t1', messages)
    expect(tracker.getRepos('t1')).toEqual(['/home/user/repo'])
  })

  it('seeds only once per thread (idempotent)', async () => {
    const repoRootFn = vi.fn().mockResolvedValue('/home/user/project')
    const cli = mockGitCli(repoRootFn)
    const tracker = createRepoTracker(cli)

    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/home/user/project/a.ts' } }]
      }
    ]

    await tracker.seedFromHistory('t1', messages)
    const callsAfterFirst = repoRootFn.mock.calls.length

    await tracker.seedFromHistory('t1', messages)
    expect(repoRootFn.mock.calls.length).toBe(callsAfterFirst) // no new calls
  })

  it('hasSeeded returns false for un-seeded threads', () => {
    const cli = mockGitCli(async () => null)
    const tracker = createRepoTracker(cli)
    expect(tracker.hasSeeded('t1')).toBe(false)
  })

  it('combines seeded and live-tracked repos', async () => {
    const cli = mockGitCli(async (cwd) => {
      if (cwd.startsWith('/home/user/alpha')) return '/home/user/alpha'
      if (cwd.startsWith('/home/user/beta')) return '/home/user/beta'
      return null
    })
    const tracker = createRepoTracker(cli)

    // Seed from history
    await tracker.seedFromHistory('t1', [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/home/user/alpha/a.ts' } }]
      }
    ])

    // Live tool call
    await tracker.trackWorkItem('t1', 'Read', JSON.stringify({ file_path: '/home/user/beta/b.ts' }))

    const repos = tracker.getRepos('t1')
    expect(repos).toHaveLength(2)
    expect(repos).toContain('/home/user/alpha')
    expect(repos).toContain('/home/user/beta')
  })
})
