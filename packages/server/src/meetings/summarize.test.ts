import { describe, it } from 'vitest'

describe('§8.3.1 Meeting Summarization', () => {
  it.todo('§8.3.1 MUST trigger summarization automatically when transcript completes and autoSummarize is true')
  it.todo('§8.3.1 MUST use the agent backend (via chat module) to generate summaries')
  it.todo('§8.3.1 MUST generate a narrative summary')
  it.todo('§8.3.1 MUST extract action items with assignee and optional due dates')
  it.todo('§8.3.1 MUST extract key decisions')
  it.todo('§8.3.1 MUST extract key topics')
  it.todo('§8.3.1 MUST include speaker labels in the summarization prompt')
  it.todo('§8.3.1 MUST be non-blocking (queued like transcription)')
})

describe('§8.3.2 Workspace Context Integration', () => {
  it.todo('§8.3.2 MUST write meeting summaries as Markdown files to {dataDir}/meetings/{orgId}/context/')
  it.todo('§8.3.2 MUST use the specified context file format')
  it.todo('§8.3.2 MUST index context files for search')
  it.todo('§8.3.2 MUST provide GET /api/orgs/:orgId/meetings/context route')
  it.todo('§8.3.2 MUST support ?since=<ISO date> parameter')
  it.todo('§8.3.2 MUST support ?limit=N parameter')
})
