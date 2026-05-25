// Change set management

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import type { EventBus } from '@sovereign/core'
import type { ChangeSet, DiffEngine } from './types.js'
import type { FileDiff } from './types.js'
// diffFile is available for getChangeSetFileDiff when projectPath context is provided

export interface ChangeSetManager extends Pick<
  DiffEngine,
  'createChangeSet' | 'getChangeSet' | 'listChangeSets' | 'updateChangeSet' | 'deleteChangeSet' | 'getChangeSetFileDiff'
> {}

export function createChangeSetManager(bus: EventBus, dataDir: string): ChangeSetManager {
  const reviewsDir = path.join(dataDir, 'reviews')
  fs.mkdirSync(reviewsDir, { recursive: true })

  // In-memory cache
  const changeSets = new Map<string, ChangeSet>()

  // Load existing on startup
  try {
    for (const file of fs.readdirSync(reviewsDir)) {
      if (file.endsWith('.json')) {
        const data = JSON.parse(fs.readFileSync(path.join(reviewsDir, file), 'utf-8'))
        changeSets.set(data.id, data)
      }
    }
  } catch {
    /* empty dir or read error */
  }

  function persist(cs: ChangeSet) {
    const target = path.join(reviewsDir, `${cs.id}.json`)
    const tmp = target + '.tmp.' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(cs, null, 2))
    fs.renameSync(tmp, target)
  }

  function remove(id: string) {
    const target = path.join(reviewsDir, `${id}.json`)
    try {
      fs.unlinkSync(target)
    } catch {
      /* already gone */
    }
  }

  async function createChangeSet(data: {
    orgId: string
    projectId: string
    worktreeId?: string
    baseBranch: string
    headBranch: string
    title: string
    description?: string
    projectPath?: string
  }): Promise<ChangeSet> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    // Get file list from git if projectPath available
    let files: ChangeSet['files'] = []
    const projectPath = (data as { projectPath?: string }).projectPath
    if (projectPath) {
      try {
        const output = execSync(`git diff --numstat ${data.baseBranch}...${data.headBranch}`, {
          cwd: projectPath,
          encoding: 'utf-8'
        })
        for (const line of output.trim().split('\n').filter(Boolean)) {
          const [add, del, filePath] = line.split('\t')
          const additions = add === '-' ? 0 : parseInt(add)
          const deletions = del === '-' ? 0 : parseInt(del)
          let status = 'modified'
          // Check status
          const statusOutput = execSync(
            `git diff --name-status ${data.baseBranch}...${data.headBranch} -- "${filePath}"`,
            { cwd: projectPath, encoding: 'utf-8' }
          ).trim()
          if (statusOutput.startsWith('A')) status = 'added'
          else if (statusOutput.startsWith('D')) status = 'deleted'
          else if (statusOutput.startsWith('R')) status = 'renamed'

          files.push({ path: filePath, status, additions, deletions })
        }
      } catch {
        /* no git or no diff */
      }
    }

    const cs: ChangeSet = {
      id,
      title: data.title,
      description: data.description ?? '',
      orgId: data.orgId,
      projectId: data.projectId,
      worktreeId: data.worktreeId,
      baseBranch: data.baseBranch,
      headBranch: data.headBranch,
      files,
      status: 'open',
      createdAt: now,
      updatedAt: now
    }

    changeSets.set(id, cs)
    persist(cs)

    bus.emit({
      type: 'changeset.created',
      timestamp: now,
      source: 'diff',
      payload: { changeSetId: id }
    })

    return cs
  }

  function getChangeSet(id: string): ChangeSet | undefined {
    return changeSets.get(id)
  }

  function listChangeSets(filter?: { orgId?: string; status?: string }): ChangeSet[] {
    let result = Array.from(changeSets.values())
    if (filter?.orgId) result = result.filter((cs) => cs.orgId === filter.orgId)
    if (filter?.status) result = result.filter((cs) => cs.status === filter.status)
    return result
  }

  function updateChangeSet(id: string, patch: Partial<ChangeSet>): ChangeSet {
    const cs = changeSets.get(id)
    if (!cs) throw new Error(`ChangeSet ${id} not found`)

    const updated = { ...cs, ...patch, id, updatedAt: new Date().toISOString() }
    changeSets.set(id, updated)
    persist(updated)

    bus.emit({
      type: patch.status === 'closed' ? 'changeset.closed' : 'changeset.updated',
      timestamp: updated.updatedAt,
      source: 'diff',
      payload: { changeSetId: id }
    })

    return updated
  }

  function deleteChangeSet(id: string): void {
    changeSets.delete(id)
    remove(id)
  }

  async function getChangeSetFileDiff(changeSetId: string, _filePath: string): Promise<FileDiff> {
    const cs = changeSets.get(changeSetId)
    if (!cs) throw new Error(`ChangeSet ${changeSetId} not found`)

    throw new Error(`Cannot diff file without project path context`)
  }

  return {
    createChangeSet,
    getChangeSet,
    listChangeSets,
    updateChangeSet,
    deleteChangeSet,
    getChangeSetFileDiff
  }
}
