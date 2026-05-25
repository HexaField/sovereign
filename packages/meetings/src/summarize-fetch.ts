// HTTP-backed summarization callback. Used by `createSummarizationPipeline`
// when `SOVEREIGN_SUMMARIZE_URL` is configured.

import type { Meeting, ActionItem } from './meetings.js'

export interface SummaryShape {
  text: string
  actionItems: ActionItem[]
  decisions: string[]
  keyTopics: string[]
}

export function makeFetchSummarizer(): (_m: Meeting, transcriptText: string) => Promise<SummaryShape> {
  return async (_m, transcriptText) => {
    const url = process.env.SOVEREIGN_SUMMARIZE_URL
    if (!url) {
      return {
        text: 'Summarization not configured — set SOVEREIGN_SUMMARIZE_URL',
        actionItems: [],
        decisions: [],
        keyTopics: []
      }
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `Summarize the following meeting transcript. Return JSON with fields: text (string summary), actionItems (array of {text, assignee?}), decisions (string[]), keyTopics (string[]).\n\nTranscript:\n${transcriptText}`
        })
      })
      if (!res.ok) throw new Error(`Summarize endpoint returned ${res.status}`)
      const data = await res.json()
      const rawItems: any[] = Array.isArray(data.actionItems) ? data.actionItems : []
      const actionItems: ActionItem[] = rawItems.map((i) => ({
        text: i.text ?? '',
        assignee: i.assignee,
        dueDate: i.dueDate,
        status: (i.status as 'open' | 'done') ?? 'open'
      }))
      return {
        text: data.text ?? data.summary ?? 'No summary returned',
        actionItems,
        decisions: data.decisions ?? [],
        keyTopics: data.keyTopics ?? []
      }
    } catch (err: any) {
      return {
        text: `Summarization failed: ${err.message}`,
        actionItems: [],
        decisions: [],
        keyTopics: []
      }
    }
  }
}
