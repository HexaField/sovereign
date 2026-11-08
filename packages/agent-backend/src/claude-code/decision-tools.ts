// Decision tools: an agent leaves a question for the user instead of asking
// it in chat (decision_open), or records that one got settled elsewhere
// (decision_close). The user answers them in the Forge's Decisions view, many
// at once; each thread gets one message with all of its resolutions. Bound
// late by the server to the work graph's decision service.

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { DECISION_SOURCE_KINDS, type Decision, type DecisionSource } from '@sovereign/core'
import { z } from 'zod'

export const DECISION_TOOLS = ['decision_open', 'decision_close'] as const

export interface DecisionOpenInput {
  question: string
  context?: string
  options?: string[]
  source?: DecisionSource
  group?: string
  /** Receives the resolution. */
  threadId: string
  /** Undefined: the server takes the calling thread's membrane. */
  membrane?: string
  /** The calling thread; its membrane is the default. */
  createdBy: string
}

/** Late-bound by the server once the forge service exists. */
export interface DecisionMcpDeps {
  open?(input: DecisionOpenInput): Promise<Decision>
  close?(id: string, resolution: string): Promise<Decision>
}

const okJson = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] })

export const DECISION_OPEN_DESCRIPTION =
  'Register a decision the user has to make. Use this INSTEAD of asking the user a question in chat whenever the answer can wait: ' +
  'the user answers open decisions together in the Forge Decisions view, and the resolution comes back to this thread ' +
  '(or `threadId`) as one "[Decisions resolved]" message. Keep working on what does not depend on the answer. ' +
  'Put the same `group` name on related questions (e.g. the plan or feature they belong to) so they are answered together. ' +
  'One question per call, one line; `context` says briefly why it matters; `options` lists the answers you would suggest; ' +
  '`source` says where it came up (a plan path, a thread id, a work-graph node id). ' +
  "`membrane` defaults to this thread's membrane. Returns the decision with its id."

export const DECISION_CLOSE_DESCRIPTION =
  'Close an open decision that got settled elsewhere (the user answered in chat, or the question no longer applies): ' +
  'records the resolution so it leaves the open list. Sends no message to anyone.'

/** decision_open / decision_close, once the server has bound them; none for a session without a calling thread. */
export function decisionTools(deps: DecisionMcpDeps | undefined, threadId: string | undefined): any[] {
  if (!deps?.open || !deps.close || !threadId) return []
  const open = deps.open
  const close = deps.close
  return [
    tool(
      'decision_open',
      DECISION_OPEN_DESCRIPTION,
      {
        question: z.string().trim().min(1).describe('The decision to make, as one line.'),
        context: z.string().optional().describe('Why it matters: a few lines of markdown.'),
        options: z.array(z.string().trim().min(1)).max(10).optional().describe('Suggested answers.'),
        source: z
          .object({
            kind: z.enum(DECISION_SOURCE_KINDS as [string, ...string[]]),
            ref: z.string().trim().min(1).describe('A plan path, thread id, node id, or free text.'),
            label: z.string().optional().describe('How to show it, e.g. the plan title.')
          })
          .optional()
          .describe('Where the question came up.'),
        group: z.string().optional().describe('A group name shared by related decisions.'),
        threadId: z.string().optional().describe('The thread that receives the resolution. Default: this thread.'),
        membrane: z.string().optional().describe("The membrane id. Default: this thread's membrane.")
      },
      async (args) =>
        okJson(
          await open({
            question: args.question,
            ...(args.context ? { context: args.context } : {}),
            ...(args.options?.length ? { options: args.options } : {}),
            ...(args.source ? { source: args.source as DecisionSource } : {}),
            ...(args.group?.trim() ? { group: args.group } : {}),
            threadId: args.threadId?.trim() || threadId,
            ...(args.membrane?.trim() ? { membrane: args.membrane.trim() } : {}),
            createdBy: threadId
          })
        )
    ),
    tool(
      'decision_close',
      DECISION_CLOSE_DESCRIPTION,
      {
        id: z.string().trim().min(1).describe('The decision id (forge-decision://…).'),
        resolution: z.string().trim().min(1).describe('What was decided.')
      },
      async (args) => okJson(await close(args.id, args.resolution))
    )
  ]
}
