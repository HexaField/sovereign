// stdio MCP server with one tool, `edit` (sessions see mcp__code__edit).
// Sovereign starts one per agent session (agent-backend claude-code/config.ts);
// `--edit-roots <dir>:<dir>` names the only directories edits may touch.

import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { editFile } from './edit-file.js'
import { EditError } from './types.js'

const DESCRIPTION = `Edit code by naming a symbol instead of quoting its text. Reads the file from disk itself: no Read needed first. Ops run in order; if one fails, nothing is written.
- replace {symbol, code}: swap a whole declaration. Leading comments in code replace the old comments, leading decorators the old decorators. What code omits stays: comments, decorators, export/pub, a comment after the declaration on its last line. For a function held in a const, code without const/let/export replaces only the value.
- replace_in {symbol?, find, to?, code}: replace text inside a symbol, or anywhere in the file without one. find, and to after it, must each match once; indentation differences are forgiven. to extends the match to the end of to. After an exact match code goes in as written; otherwise it is re-indented to the match.
- insert {code, after?|before?}: add code beside a symbol, or at the end of the file.
- remove {symbol}: delete a declaration with its comments, decorators and overloads.
- create {code}: make a new file (first op only).
symbol: name, Container::name or Container.name; add @line when names repeat. An edit that adds a syntax error is rejected. Returns a unified diff, plus callers when a signature changes.`

// Strict objects: a misspelt key is an error, not dropped (a dropped `after`
// appends at the end of the file, a dropped `dryRun` writes), and the schema
// says so with additionalProperties: false.
const op = z.discriminatedUnion(
  'op',
  [
    z.strictObject({ op: z.literal('replace'), symbol: z.string(), code: z.string() }),
    z.strictObject({
      op: z.literal('replace_in'),
      symbol: z.string().optional(),
      find: z.string(),
      to: z.string().optional(),
      code: z.string()
    }),
    z.strictObject({
      op: z.literal('insert'),
      code: z.string(),
      after: z.string().optional(),
      before: z.string().optional()
    }),
    z.strictObject({ op: z.literal('remove'), symbol: z.string() }),
    z.strictObject({ op: z.literal('create'), code: z.string() })
  ],
  {
    error: (iss) =>
      iss.code === 'invalid_union' ? 'op must be replace, replace_in, insert, remove or create' : undefined
  }
)

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

/** Absent or empty: editFile's default, the home directory. */
const roots = argValue('edit-roots')?.split(path.delimiter).filter(Boolean)

const server = new McpServer({ name: 'code', version: '1.0.0' })

server.registerTool(
  'edit',
  {
    description: DESCRIPTION,
    inputSchema: z.strictObject({
      file: z.string().describe('Absolute path of the file'),
      ops: z.array(op).min(1),
      dryRun: z.boolean().optional().describe('Report the diff without writing')
    })
  },
  async (args) => {
    try {
      const result = await editFile(args, { roots: roots?.length ? roots : undefined })
      return { content: [{ type: 'text' as const, text: result.report }] }
    } catch (err) {
      const text =
        err instanceof EditError
          ? `${err.message}\nNothing was written.`
          : `edit failed: ${(err as Error).stack ?? err}`
      return { content: [{ type: 'text' as const, text }], isError: true }
    }
  }
)

server.connect(new StdioServerTransport()).catch((err) => {
  console.error('code-edit MCP server failed to start:', err)
  process.exit(1)
})
