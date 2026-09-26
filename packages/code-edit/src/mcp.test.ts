// The stdio server as a session meets it: spawned with --edit-roots, driven by
// the MCP SDK's client. The source runs under tsx, so no build is needed.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const SERVER = fileURLToPath(new URL('./mcp.ts', import.meta.url))
const serverArgs = (root: string) => ['--import', TSX, SERVER, '--edit-roots', root]

const SRC = 'export function greet() {\n  return 1\n}\n\nexport function bye() {\n  return 2\n}\n'
let root: string
let file: string
let client: Client

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-edit-mcp-'))
  file = path.join(root, 'a.ts')
  client = new Client({ name: 'test', version: '0' })
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: serverArgs(root), stderr: 'ignore' })
  )
}, 30_000)

afterAll(async () => {
  await client?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(() => fs.writeFileSync(file, SRC))

async function edit(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const res = (await client.callTool({ name: 'edit', arguments: args })) as {
    content: Array<{ text: string }>
    isError?: boolean
  }
  return { text: res.content[0].text, isError: res.isError === true }
}

describe('code-edit MCP server', () => {
  it('lists one tool, edit, whose schema admits only the keys it names', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['edit'])
    expect(tools[0].inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { ops: { items: { oneOf: Array(5).fill({ additionalProperties: false }) } } }
    })
  })

  it('edits a file inside --edit-roots and refuses one outside', async () => {
    const done = await edit({ file, ops: [{ op: 'remove', symbol: 'bye' }] })
    expect(done).toMatchObject({ isError: false, text: expect.stringContaining('remove bye') })
    expect(fs.readFileSync(file, 'utf8')).toBe('export function greet() {\n  return 1\n}\n')

    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'code-edit-outside-'))
    try {
      const outside = path.join(other, 'a.ts')
      fs.writeFileSync(outside, SRC)
      const refused = await edit({ file: outside, ops: [{ op: 'remove', symbol: 'bye' }] })
      expect(refused).toMatchObject({ isError: true, text: expect.stringContaining('outside the allowed roots') })
      expect(fs.readFileSync(outside, 'utf8')).toBe(SRC)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('rejects a misspelt key rather than editing as if it were absent', async () => {
    // Dropped silently, `afer` would append at the end of the file, and `dry_run` would write.
    for (const args of [
      { file, ops: [{ op: 'insert', afer: 'greet', code: 'export function hi() {}' }] },
      { file, dry_run: true, ops: [{ op: 'remove', symbol: 'bye' }] }
    ]) {
      expect(await edit(args)).toMatchObject({ isError: true, text: expect.stringContaining('Unrecognized key') })
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(SRC)
  })

  it('names the ops when it gets an unknown one', async () => {
    const res = await edit({ file, ops: [{ op: 'rename', symbol: 'greet' }] })
    expect(res).toMatchObject({
      isError: true,
      text: expect.stringContaining('replace, replace_in, insert, remove or create')
    })
  })

  it('exits when the client closes its stdin', async () => {
    const child = spawn(process.execPath, serverArgs(root), { stdio: ['pipe', 'ignore', 'ignore'] })
    const exit = new Promise<number | null>((resolve) => child.on('exit', resolve))
    child.stdin.end()
    expect(await exit).toBe(0)
  }, 30_000)
})
