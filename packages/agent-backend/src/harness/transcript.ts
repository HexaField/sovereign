// A harness run's transcript as ParsedTurns, for the subagent view: Devin's
// ATIF export, OpenCode's and Codex's JSON event streams on stdout. A
// transcript that does not parse yields no turns; the runner then shows stdout.

import fs from 'node:fs'
import type { ParsedTurn, WorkItem } from '@sovereign/core'
import { plainText } from './adapter.js'

function assistantTurn(timestamp: number): ParsedTurn {
  return { role: 'assistant', content: '', timestamp, workItems: [], thinkingBlocks: [] }
}

function json(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {})
}

/** Tool output as text: a string as is, MCP content blocks joined, anything else as JSON. */
function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((b) => typeof b?.text === 'string')) {
    return value.map((b) => b.text).join('\n')
  }
  return JSON.stringify(value ?? '')
}

function keep(turn: ParsedTurn): boolean {
  return !!(turn.content.trim() || turn.workItems.length || turn.thinkingBlocks.length)
}

/**
 * Devin's `--export` file (ATIF, Agent Trajectory Interchange Format): one
 * assistant turn per agent step, its reasoning as a thinking block, its tool
 * calls and their observations as work items. System and user steps (the
 * brief) are left out: the runner puts the task first.
 */
export function atifTurns(exportFile: string): ParsedTurn[] {
  let doc: any
  try {
    doc = JSON.parse(fs.readFileSync(exportFile, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(doc?.steps)) return []
  const turns: ParsedTurn[] = []
  for (const step of doc.steps) {
    if (step?.source !== 'agent') continue
    const ts = Date.parse(step.timestamp) || 0
    const turn = assistantTurn(ts)
    turn.content = typeof step.message === 'string' ? step.message : ''
    if (typeof step.reasoning_content === 'string' && step.reasoning_content.trim()) {
      turn.thinkingBlocks.push(step.reasoning_content)
    }
    for (const call of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
      const args = call?.arguments
      // Devin calls MCP tools through one tool: show them as Claude names them.
      const mcp = call?.function_name === 'mcp_call_tool' && args?.server_name && args?.tool_name
      turn.workItems.push({
        type: 'tool_call',
        name: mcp ? `mcp__${args.server_name}__${args.tool_name}` : String(call?.function_name ?? 'tool'),
        input: json(mcp ? args.arguments : args),
        toolCallId: String(call?.tool_call_id ?? ''),
        timestamp: ts
      })
    }
    for (const result of Array.isArray(step.observation?.results) ? step.observation.results : []) {
      turn.workItems.push({
        type: 'tool_result',
        output: outputText(result?.content),
        toolCallId: String(result?.source_call_id ?? ''),
        timestamp: ts
      })
    }
    if (keep(turn)) turns.push(turn)
  }
  return turns
}

function jsonLines(stdout: string): any[] {
  const events: any[] = []
  for (const line of plainText(stdout).split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* a partial or non-JSON line */
    }
  }
  return events
}

/**
 * `opencode run --format json` stdout: one assistant turn per message
 * (`part.messageID`), with its text, reasoning and tool parts.
 */
export function opencodeTurns(stdout: string): ParsedTurn[] {
  const turns = new Map<string, ParsedTurn>()
  for (const e of jsonLines(stdout)) {
    const part = e?.part
    if (!part) continue
    const id = String(part.messageID ?? '')
    const ts = Number(e.timestamp ?? part.time?.start ?? 0) || 0
    let turn = turns.get(id)
    if (!turn) {
      turn = assistantTurn(ts)
      turns.set(id, turn)
    }
    if (e.type === 'text' && typeof part.text === 'string') {
      turn.content = [turn.content, part.text.trim()].filter(Boolean).join('\n\n')
    } else if (e.type === 'reasoning' && typeof part.text === 'string') {
      turn.thinkingBlocks.push(part.text)
    } else if (e.type === 'tool_use') {
      const callId = String(part.callID ?? part.id ?? '')
      turn.workItems.push({
        type: 'tool_call',
        name: String(part.tool ?? 'tool'),
        input: json(part.state?.input),
        toolCallId: callId,
        timestamp: ts
      })
      if (part.state?.output !== undefined || part.state?.error !== undefined) {
        turn.workItems.push({
          type: 'tool_result',
          output: outputText(part.state.output ?? part.state.error),
          toolCallId: callId,
          timestamp: ts
        })
      }
    }
  }
  return [...turns.values()].filter(keep)
}

/**
 * `codex exec --json` stdout: each completed item in order. Each agent
 * message is a turn; the reasoning, commands, MCP calls and file changes
 * between two messages make one turn of work items. The events carry no
 * time: every turn gets `at`.
 */
export function codexTurns(stdout: string, at: number): ParsedTurn[] {
  const turns: ParsedTurn[] = []
  let turn: ParsedTurn | undefined
  const current = (): ParsedTurn => {
    if (!turn) {
      turn = assistantTurn(at)
      turns.push(turn)
    }
    return turn
  }
  for (const e of jsonLines(stdout)) {
    if (e?.type !== 'item.completed' || !e.item) continue
    const item = e.item
    const id = String(item.id ?? '')
    const tool = (name: string, input: unknown, output: unknown): WorkItem[] => [
      { type: 'tool_call', name, input: json(input), toolCallId: id, timestamp: at },
      { type: 'tool_result', output: outputText(output), toolCallId: id, timestamp: at }
    ]
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      // A message is a turn of its own, after the work that led to it.
      turns.push({ ...assistantTurn(at), content: item.text })
      turn = undefined
    } else if (item.type === 'reasoning' && typeof item.text === 'string') {
      current().thinkingBlocks.push(item.text)
    } else if (item.type === 'command_execution') {
      current().workItems.push(...tool('Bash', { command: item.command }, item.aggregated_output ?? ''))
    } else if (item.type === 'mcp_tool_call') {
      current().workItems.push(
        ...tool(`mcp__${item.server}__${item.tool}`, item.arguments, item.result?.content ?? item.error ?? '')
      )
    } else if (item.type === 'file_change') {
      current().workItems.push(...tool('Edit', { changes: item.changes }, item.status ?? ''))
    }
  }
  return turns.filter(keep)
}
