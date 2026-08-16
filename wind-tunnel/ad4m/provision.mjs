#!/usr/bin/env node
// Wind-tunnel ad4m lane — provision step.
//
// Runs once, in-network, before Sovereign boots. Signs up + logs in a user on
// the multi-user ad4m node, mints a channel perspective, then writes two files
// into the shared out dir:
//
//   ad4m-token.json  — { "token": "<jwt>" }  → Sovereign reads this as its
//                       ad4m credential at boot (dataDir/ad4m-token.json), so
//                       its native waker connects as this same user.
//   provision.json   — { jwt, did, uuid, channel, linkLanguageTemplate } →
//                       the s10 scenario reads jwt/uuid/channel (on the host)
//                       to inject the mention + verify the reply as the exact
//                       user/perspective the waker watches. The s31 scenario
//                       reads linkLanguageTemplate too, to publish a
//                       neighbourhood on the node's local (non-Holochain)
//                       link language without hardcoding its
//                       content-addressed hash.
//
// Usage: node provision.mjs <mcpBase> <outDir>
//   env: ADMIN_CREDENTIAL, AD4M_EMAIL, AD4M_PASSWORD, AD4M_CHANNEL

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient, pick } from './mcp-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
void HERE

const [mcpBase, outDir] = process.argv.slice(2)
const ADMIN = process.env.ADMIN_CREDENTIAL || 'windtunnel-admin'
const EMAIL = process.env.AD4M_EMAIL || 'sovereign-wt@agent.local'
const PASS = process.env.AD4M_PASSWORD || 'sovereign-wt-pass-123'
const CHANNEL = process.env.AD4M_CHANNEL || 'swt-ad4m://channel'

if (!mcpBase || !outDir) {
  console.error('usage: provision.mjs <mcpBase> <outDir>')
  process.exit(2)
}

async function waitForNode(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const c = new McpClient(base, ADMIN)
      await c.initialize('swt-provision-probe')
      return c
    } catch {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw new Error(`ad4m node MCP at ${base} never became ready`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const admin = await waitForNode(mcpBase)

  // MCP answers `initialize` before the executor finishes generating its agent +
  // token-signing key, so signup/login can transiently fail with "main key not
  // found". Retry the whole handshake until a JWT lands (or we give up).
  let jwt = ''
  for (let i = 0; i < 40 && !jwt; i++) {
    try {
      await admin.callToolJson('signup', { email: EMAIL, password: PASS })
    } catch {
      /* user may already exist */
    }
    let login
    try {
      login = await admin.callToolJson('login_email', { email: EMAIL, password: PASS })
    } catch (e) {
      login = { error: String(e?.message ?? e) }
    }
    jwt = pick(login, 'token', 'jwt', 'access_token')
    if (!jwt) {
      if (i === 0 || i % 5 === 0) console.error(`[swt-provision] waiting for token key… (${JSON.stringify(login).slice(0, 120)})`)
      await sleep(3000)
    }
  }
  if (!jwt) throw new Error('no JWT from login_email after retries (node never finished key generation)')

  const user = new McpClient(mcpBase, jwt)
  await user.initialize('swt-provision-user')
  const did = pick(await user.callToolJson('get_my_did', {}), 'did', 'result')
  const persp = await user.callToolJson('add_perspective', { name: 'swt-ad4m-channel' })
  const uuid = persp?.uuid || pick(persp, 'uuid', 'perspectiveUuid')
  if (!uuid) throw new Error(`no perspective uuid: ${JSON.stringify(persp).slice(0, 200)}`)

  // Discover the local (non-Holochain) link language template baked into the
  // node's bootstrap seed (knownLinkLanguages) so s31 can publish a
  // neighbourhood without hardcoding a content-addressed language hash. A
  // fresh executor may not have finished hydrating runtime state from the
  // seed the instant MCP starts answering — same class of race as the JWT
  // wait above — so retry briefly before giving up.
  let linkLanguageTemplate = ''
  for (let i = 0; i < 10 && !linkLanguageTemplate; i++) {
    let templates
    try {
      templates = await user.callToolJson('list_link_language_templates', {})
    } catch (e) {
      templates = { error: String(e?.message ?? e) }
    }
    const list = Array.isArray(templates?.templates) ? templates.templates : []
    linkLanguageTemplate = pick(list[0] || {}, 'address')
    if (!linkLanguageTemplate) await sleep(2000)
  }
  if (!linkLanguageTemplate) {
    console.error(
      '[swt-provision] WARNING: no link language templates found (list_link_language_templates returned none) — ' +
        's31 will fail; check the ad4m-test image ships a local bootstrap seed with knownLinkLanguages'
    )
  }

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'ad4m-token.json'), JSON.stringify({ token: jwt }))
  fs.writeFileSync(
    path.join(outDir, 'provision.json'),
    JSON.stringify({ jwt, did, uuid, channel: CHANNEL, linkLanguageTemplate }, null, 2)
  )
  console.log(
    `[swt-provision] did=${did} uuid=${uuid} channel=${CHANNEL} linkLanguageTemplate=${linkLanguageTemplate || '<none>'} — wrote token + manifest to ${outDir}`
  )
})().catch((e) => {
  console.error('[swt-provision] FATAL', e?.stack || e)
  process.exit(1)
})
