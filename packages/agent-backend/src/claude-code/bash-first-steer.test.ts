// The bundled Claude Code CLI, in bypass permission mode, can add a reminder
// that steers the model to edit files with sed, heredocs or scripts.
// BASH_FIRST_OFF_ENV must switch it off. Both cases run the real CLI against
// a local stub API and read the request it sends, so an SDK upgrade that
// renames the internal flag fails the "on" case instead of passing silently.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { BASH_FIRST_OFF_ENV } from './claude-code.js'

const STEER = 'While bypass permissions mode is active'

describe('CLI bash-first steer', () => {
  let server: http.Server
  let baseUrl: string
  let requests: string[] = []
  let cwd: string

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'sov-bash-first-'))
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        if (req.url?.includes('/v1/messages') && !req.url.includes('count_tokens')) requests.push(body)
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stub' } }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
    rmSync(cwd, { recursive: true, force: true })
  })

  /** The body of the first model request the CLI sends with `steerEnv` applied. */
  async function firstRequest(steerEnv: Record<string, string>): Promise<string> {
    requests = []
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 30_000)
    try {
      const q = query({
        prompt: 'hi',
        options: {
          cwd,
          model: 'claude-opus-4-6',
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: [],
          abortController: abort,
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: baseUrl,
            ANTHROPIC_API_KEY: 'stub',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            CLAUDE_CODE_MAX_RETRIES: '0',
            ...steerEnv
          } as Record<string, string>
        }
      })
      for await (const message of q) if (message.type === 'result') break
    } catch {
      // The stub answers every call with an error; only the request matters.
    } finally {
      clearTimeout(timer)
    }
    expect(requests.length).toBeGreaterThan(0)
    return requests[0]
  }

  it('appears when the flag forces it on — the flag still controls the steer', async () => {
    const body = await firstRequest({ [Object.keys(BASH_FIRST_OFF_ENV)[0]]: '1' })
    expect(body).toContain(STEER)
  }, 60_000)

  it('is absent with BASH_FIRST_OFF_ENV', async () => {
    const body = await firstRequest(BASH_FIRST_OFF_ENV)
    expect(body).not.toContain(STEER)
  }, 60_000)
})
