// Summarization pipeline — §8.3

import type { EventBus } from '@sovereign/core'
import type { MeetingsService, Meeting, ActionItem } from './meetings.js'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export interface SummarizationResult {
  text: string
  actionItems: ActionItem[]
  decisions: string[]
  keyTopics: string[]
}

export interface SummarizationConfig {
  autoSummarize?: boolean
}

export interface SummarizationPipeline {
  summarize(orgId: string, meetingId: string): Promise<void>
  getContext(orgId: string, options?: { since?: string; limit?: number }): Promise<string[]>
  destroy(): void
}

function contextDir(dataDir: string, orgId: string): string {
  return path.join(dataDir, 'meetings', orgId, 'context')
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp.' + crypto.randomUUID()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, filePath)
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}h ${m}m`
}

function buildContextMarkdown(meeting: Meeting, result: SummarizationResult): string {
  const speakers = meeting.transcript?.speakers
    ? Object.values(meeting.transcript.speakers)
        .map((s: unknown) => (s as { label?: string }).label)
        .filter(Boolean)
        .join(', ')
    : 'Unknown'

  const lines = [
    `# Meeting: ${meeting.title}`,
    '',
    `**Date:** ${meeting.startedAt ?? meeting.createdAt}  **Duration:** ${formatDuration(meeting.duration)}  **Participants:** ${speakers}`,
    '',
    '## Summary',
    '',
    result.text,
    ''
  ]

  if (result.actionItems.length > 0) {
    lines.push('## Action Items', '')
    for (const item of result.actionItems) {
      const assignee = item.assignee ? ` — @${item.assignee}` : ''
      lines.push(`- [ ] ${item.text}${assignee}`)
    }
    lines.push('')
  }

  if (result.decisions.length > 0) {
    lines.push('## Decisions', '')
    for (const d of result.decisions) {
      lines.push(`- ${d}`)
    }
    lines.push('')
  }

  if (result.keyTopics.length > 0) {
    lines.push('## Key Topics', '')
    lines.push(result.keyTopics.join(', '))
    lines.push('')
  }

  return lines.join('\n')
}

export function createSummarizationPipeline(deps: {
  bus: EventBus
  meetings: MeetingsService
  dataDir: string
  config?: SummarizationConfig
  onSummarize: (meeting: Meeting, transcriptText: string) => Promise<SummarizationResult>
}): SummarizationPipeline {
  const { bus, meetings, dataDir, config, onSummarize } = deps
  const autoSummarize = config?.autoSummarize ?? true
  const queue: Array<{ orgId: string; meetingId: string }> = []
  let processing = false

  async function processQueue(): Promise<void> {
    if (processing) return
    processing = true
    while (queue.length > 0) {
      const item = queue.shift()!
      try {
        await doSummarize(item.orgId, item.meetingId)
      } catch (err) {
        await meetings
          .update(item.orgId, item.meetingId, {
            summary: {
              status: 'failed',
              error: (err as Error).message,
              actionItems: [],
              decisions: [],
              keyTopics: []
            }
          })
          .catch(() => {})
      }
    }
    processing = false
  }

  async function doSummarize(orgId: string, meetingId: string): Promise<void> {
    const meeting = await meetings.get(orgId, meetingId)
    if (!meeting || !meeting.transcript?.text) return

    await meetings.update(orgId, meetingId, {
      summary: { status: 'pending', actionItems: [], decisions: [], keyTopics: [] }
    })

    const result = await onSummarize(meeting, meeting.transcript.text)

    await meetings.update(orgId, meetingId, {
      summary: {
        status: 'completed',
        text: result.text,
        actionItems: result.actionItems,
        decisions: result.decisions,
        keyTopics: result.keyTopics,
        completedAt: new Date().toISOString()
      }
    })

    // Write context file
    const updatedMeeting = await meetings.get(orgId, meetingId)
    if (updatedMeeting) {
      const md = buildContextMarkdown(updatedMeeting, result)
      const ctxDir = contextDir(dataDir, orgId)
      fs.mkdirSync(ctxDir, { recursive: true })
      atomicWrite(path.join(ctxDir, `${meetingId}.md`), md)
    }

    bus.emit({
      type: 'meeting.summary.completed',
      timestamp: new Date().toISOString(),
      source: 'summarize',
      payload: { orgId, meetingId, threadKey: meeting.threadKey }
    })
  }

  // Auto-trigger on transcript completion
  const unsub = autoSummarize
    ? bus.on('meeting.transcript.completed', (event) => {
        const { orgId, meetingId } = event.payload as { orgId: string; meetingId: string }
        queue.push({ orgId, meetingId })
        processQueue()
      })
    : undefined

  return {
    async summarize(orgId: string, meetingId: string): Promise<void> {
      queue.push({ orgId, meetingId })
      await processQueue()
    },

    async getContext(orgId: string, options?: { since?: string; limit?: number }): Promise<string[]> {
      const ctxDir = contextDir(dataDir, orgId)
      if (!fs.existsSync(ctxDir)) return []

      let files = fs.readdirSync(ctxDir).filter((f) => f.endsWith('.md'))
      // Sort by mtime newest first
      files.sort((a, b) => {
        const sa = fs.statSync(path.join(ctxDir, a)).mtimeMs
        const sb = fs.statSync(path.join(ctxDir, b)).mtimeMs
        return sb - sa
      })

      if (options?.since) {
        const sinceTime = new Date(options.since).getTime()
        files = files.filter((f) => fs.statSync(path.join(ctxDir, f)).mtimeMs >= sinceTime)
      }

      if (options?.limit) {
        files = files.slice(0, options.limit)
      }

      return files.map((f) => fs.readFileSync(path.join(ctxDir, f), 'utf-8'))
    },

    destroy(): void {
      if (unsub) unsub()
    }
  }
}
