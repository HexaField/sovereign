// Forge rethink tools (Loop 2, packages/work-graph rethink.ts). Registered
// only in a membrane's `forge-rethink` thread; each call goes to the server's
// rethink runner, which applies the per-run limits and records the action in
// the run report and on the node's card.

import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { ForgeToolName } from '@sovereign/core'
import { z } from 'zod'

/** Late-bound by the server once the forge service exists. */
export interface ForgeMcpDeps {
  /** The membrane whose forge-rethink thread this is; undefined for any other thread. */
  membraneOf?(threadId: string): string | undefined
  call?(threadId: string, name: ForgeToolName, args: Record<string, unknown>): Promise<unknown>
}

const okJson = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] })

/** The forge_* tools for the calling thread, or none when it is not a forge-rethink thread. */
export function forgeTools(deps: ForgeMcpDeps | undefined, threadId: string | undefined): any[] {
  if (!deps?.membraneOf || !deps.call || !threadId || !deps.membraneOf(threadId)) return []
  const call = deps.call
  const membrane = z.string().describe('The membrane id of this rethink run.')
  const nodeId = z.string().describe('A work-graph node id, e.g. "github:github.com/owner/repo#12".')
  const streamId = z.string().describe('The stream id (its task id).')
  const run = (name: ForgeToolName) => async (args: Record<string, unknown>) => okJson(await call(threadId, name, args))
  return [
    tool(
      'forge_relate',
      'Suggest a `related` edge between two work-graph nodes that no script can see (same bug, same subsystem, one blocks the other). Shown dashed on the Forge canvas until the user keeps or deletes it.',
      {
        membrane,
        from: nodeId,
        to: nodeId,
        reason: z.string().describe('One sentence: why they are related.'),
        confidence: z.number().min(0).max(1).describe('0–1.')
      },
      run('forge_relate')
    ),
    tool(
      'forge_stream_add',
      'Set the work stream that owns a node (creates its task when missing). A PR or issue has one owning stream: this moves it out of any other stream it was in.',
      { membrane, nodeId, streamId: z.string().describe('The stream id (its task id).') },
      run('forge_stream_add')
    ),
    tool(
      'forge_dispatch',
      "Send specific work about a node to its owner thread (or `threadId`): rebase/merge the base in, fix the named failing checks, answer the named review comments. Counted against the run's job limit and token budget; refused past either. Without an owner thread it starts a new thread only for a node in a work stream.",
      {
        membrane,
        nodeId,
        threadId: z.string().optional().describe('Send here instead of the owner thread.'),
        prompt: z.string().describe('What to do, with the specific comments or failures.')
      },
      run('forge_dispatch')
    ),
    tool(
      'forge_bug_draft',
      'Draft a bug report with evidence for the user to approve. Creates a draft only: nothing is posted to the forge until the user publishes it.',
      {
        membrane,
        repo: z.string().describe('"owner/name" the issue belongs to.'),
        title: z.string(),
        body: z.string().describe('Markdown: what fails, how often, since when.'),
        evidence: z.array(z.string()).min(1).describe('Node ids that show the bug.')
      },
      run('forge_bug_draft')
    ),
    tool(
      'forge_attention',
      'Post ONE "needs your attention" message to the user (the presence thread) with every item of this run. A second call in the same run is refused.',
      {
        membrane,
        items: z
          .array(z.object({ nodeId: z.string().optional(), text: z.string() }))
          .min(1)
          .describe('One line each: what the user has to decide or do.')
      },
      run('forge_attention')
    ),
    tool(
      'forge_note',
      "Leave a one-line note on a node's card (Rethink notes).",
      { membrane, nodeId, text: z.string() },
      run('forge_note')
    ),
    tool(
      'forge_stream_create',
      'Create a work stream (an epic), optionally under a parent stream. Not counted against the run limits.',
      { membrane, name: z.string(), parentId: z.string().optional().describe('The parent stream id.') },
      run('forge_stream_create')
    ),
    tool(
      'forge_stream_rename',
      'Rename a work stream. Not counted against the run limits.',
      { membrane, streamId, name: z.string() },
      run('forge_stream_rename')
    ),
    tool(
      'forge_stream_archive',
      'Archive a work stream (hidden from the Forge epics list) or bring it back (`archived: false`). A plan sync never brings back an archived stream. Not counted against the run limits.',
      { membrane, streamId, archived: z.boolean() },
      run('forge_stream_archive')
    ),
    tool(
      'forge_stream_remove',
      'Take a node out of a work stream. Not counted against the run limits.',
      { membrane, nodeId, streamId },
      run('forge_stream_remove')
    ),
    tool(
      'forge_stream_merge',
      'Move every member and child stream of one work stream into another (the second becomes their owner), then archive the first. Not counted against the run limits.',
      {
        membrane,
        fromId: z.string().describe('The stream to empty and archive.'),
        intoId: z.string().describe('The stream that receives its members.')
      },
      run('forge_stream_merge')
    ),
    tool(
      'forge_stream_parent',
      'Nest a work stream under another, or move it to the top level (`parentId: null`). Not counted against the run limits.',
      { membrane, streamId, parentId: z.string().nullable().describe('The new parent stream id, or null.') },
      run('forge_stream_parent')
    )
  ]
}
