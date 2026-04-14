import fs from 'node:fs'
import path from 'node:path'
import type { Org, Project } from '../orgs/types.js'
import type { Remote } from '../issues/types.js'

export function parseGitRemotes(repoPath: string): Remote[] {
  try {
    const gitConfigPath = path.join(repoPath, '.git', 'config')
    if (!fs.existsSync(gitConfigPath)) return []
    const config = fs.readFileSync(gitConfigPath, 'utf-8')
    const remotes: Remote[] = []

    const remoteRegex = /\[remote\s+"([^"]+)"\]\s*\n([\s\S]*?)(?=\n\[|\n*$)/g
    let match: RegExpExecArray | null

    while ((match = remoteRegex.exec(config)) !== null) {
      const remoteName = match[1]
      const section = match[2]
      const urlMatch = section?.match(/url\s*=\s*(.+)/)
      if (!urlMatch) continue
      const url = urlMatch[1].trim()

      const ghSsh = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\/?$/)
      const ghHttps = url.match(/github\.com\/([^/]+\/[^/.]+?)(?:\.git)?\/?$/)
      if (ghSsh || ghHttps) {
        remotes.push({ name: remoteName, provider: 'github', repo: (ghSsh || ghHttps)![1] })
        continue
      }

      const radMatch = url.match(/^rad:(.+)$/)
      if (radMatch) {
        remotes.push({ name: remoteName, provider: 'radicle', rid: radMatch[1] })
      }
    }

    return remotes
  } catch {
    return []
  }
}

export function orderRemotes(
  remotes: Remote[],
  opts?: { preferredRemoteName?: string; preferredProvider?: Org['provider'] }
): Remote[] {
  if (remotes.length <= 1) return [...remotes]

  const preferredByName = opts?.preferredRemoteName ? remotes.findIndex((r) => r.name === opts.preferredRemoteName) : -1
  const preferredIndex =
    preferredByName >= 0 ? preferredByName : remotes.findIndex((r) => r.provider === opts?.preferredProvider)

  if (preferredIndex <= 0) return [...remotes]

  const preferred = remotes[preferredIndex]!
  return [preferred, ...remotes.slice(0, preferredIndex), ...remotes.slice(preferredIndex + 1)]
}

export function selectPreferredRemote(
  remotes: Remote[],
  opts?: { preferredRemoteName?: string; preferredProvider?: Org['provider'] }
): Remote | undefined {
  return orderRemotes(remotes, opts)[0]
}

export function getProjectPreferredRemote(
  org: Org | undefined,
  project: Pick<Project, 'remote'> | undefined,
  repoPath: string
): string | undefined {
  const remotes = parseGitRemotes(repoPath)
  return selectPreferredRemote(remotes, {
    preferredRemoteName: project?.remote,
    preferredProvider: org?.provider
  })?.name
}
