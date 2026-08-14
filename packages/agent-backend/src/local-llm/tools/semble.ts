// Semble code search tools for the local-llm backend.
//
// Wraps the `semble` CLI (search + find-related) as OpenAI function-calling
// tools. The CLI approach avoids managing a stdio subprocess for the MCP
// transport — simpler, more robust, same results.

import { execFile } from 'node:child_process'
import type { ToolSchema } from '../inference.js'
import type { ToolResult } from './index.js'

/** Max time for a semble command before timeout. */
const SEMBLE_TIMEOUT_MS = 30_000
/** Max output length returned to the model. */
const SEMBLE_MAX_OUTPUT = 48_000

// ── Tool schemas ────────────────────────────────────────────────────────

export const SEMBLE_TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'semble_search',
      description:
        'Semantic code search — finds relevant code by natural-language query or symbol name. ' +
        'Returns file paths, line numbers, and code snippets. Use for finding where functionality ' +
        'lives, locating implementations, or discovering related patterns. Prefer over Grep for ' +
        'exploratory searches; Grep remains better for literal string sweeps.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language or code query (e.g. "authentication flow", "handleSubmit")'
          },
          path: {
            type: 'string',
            description: 'Project root to search in. Defaults to current working directory.'
          },
          top_k: {
            type: 'number',
            description: 'Number of results to return. Default: 5.'
          },
          max_snippet_lines: {
            type: 'number',
            description: 'Max lines of source per result. 10 = signature + body, 0 = no code. Default: 10.'
          },
          content: {
            type: 'string',
            enum: ['code', 'docs', 'config', 'all'],
            description: 'Content type to search. Default: code.'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'semble_find_related',
      description:
        'Find code semantically similar to a specific location. Given a file path and line number, ' +
        'returns other code chunks in the project that relate to that location. Useful for finding ' +
        'usages, related implementations, or similar patterns.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'File path as shown in search results (relative or absolute).'
          },
          line: {
            type: 'number',
            description: 'Line number (1-indexed) to find related code for.'
          },
          path: {
            type: 'string',
            description: 'Project root. Defaults to current working directory.'
          },
          top_k: {
            type: 'number',
            description: 'Number of results. Default: 5.'
          },
          max_snippet_lines: {
            type: 'number',
            description: 'Max lines of source per result. Default: 10.'
          },
          content: {
            type: 'string',
            enum: ['code', 'docs', 'config', 'all'],
            description: 'Content type. Default: code.'
          }
        },
        required: ['file_path', 'line']
      }
    }
  }
]

// ── Executor ────────────────────────────────────────────────────────────

function runSemble(args: string[]): Promise<ToolResult> {
  return new Promise((resolve) => {
    execFile('semble', args, { timeout: SEMBLE_TIMEOUT_MS, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      if (err) {
        const msg = err.killed
          ? `semble timed out after ${SEMBLE_TIMEOUT_MS / 1000}s`
          : `semble error: ${(err as Error).message}`
        resolve({ content: msg, error: msg })
        return
      }
      let output = stdout.trim()
      if (output.length > SEMBLE_MAX_OUTPUT) {
        output = output.slice(0, SEMBLE_MAX_OUTPUT) + '\n[output truncated]'
      }
      if (stderr.trim()) {
        output += `\n\n[stderr]: ${stderr.trim().slice(0, 500)}`
      }
      resolve({ content: output || '(no results)' })
    })
  })
}

export function createSembleToolExecutor(): (name: string, input: Record<string, unknown>) => Promise<ToolResult> {
  return async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    switch (name) {
      case 'semble_search': {
        const query = String(input.query ?? '')
        if (!query) return { content: 'Missing required parameter: query', error: 'missing_param' }
        const args = ['search', query]
        if (input.path) args.push(String(input.path))
        if (input.top_k) args.push('-k', String(input.top_k))
        if (input.max_snippet_lines != null) args.push('--max-snippet-lines', String(input.max_snippet_lines))
        if (input.content) args.push('--content', String(input.content))
        return runSemble(args)
      }

      case 'semble_find_related': {
        const filePath = String(input.file_path ?? '')
        const line = Number(input.line ?? 0)
        if (!filePath) return { content: 'Missing required parameter: file_path', error: 'missing_param' }
        if (!line) return { content: 'Missing required parameter: line', error: 'missing_param' }
        const args = ['find-related', filePath, String(line)]
        if (input.path) args.push(String(input.path))
        if (input.top_k) args.push('-k', String(input.top_k))
        if (input.max_snippet_lines != null) args.push('--max-snippet-lines', String(input.max_snippet_lines))
        if (input.content) args.push('--content', String(input.content))
        return runSemble(args)
      }

      default:
        return { content: `Unknown semble tool: ${name}`, error: 'unknown_tool' }
    }
  }
}
