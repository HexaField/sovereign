#!/usr/bin/env node
// Wind-tunnel ad4m lane — provision step.
//
// Runs once, in-network, before Sovereign boots. Sets up the two agents of the
// lane on one multi-user executor, the way WE's staging node hosts its users:
//
//   Hex   — the user Sovereign's waker connects as. It makes the channel
//           perspective and publishes it as a neighbourhood over the
//           server-link-language, templated with the lane's link-server.
//   Alex  — a second user with its own DID (a WE user). It joins the
//           neighbourhood by URL. On one executor a joined neighbourhood is the
//           same perspective with a second owner, so Alex's links, signed by
//           Alex's key, land in the perspective Hex's waker watches.
//
// A probe link Alex writes must reach Hex's view, authored by Alex, before the
// step succeeds. It writes two files into the shared out dir:
//
//   ad4m-token.json  — { "token": "<Hex JWT>" } → Sovereign reads this as its
//                       ad4m credential at boot (dataDir/ad4m-token.json).
//   provision.json   — both agents' JWT, DID and perspective, the channel and
//                       the neighbourhood URL → s10 (on the host) acts as each.
//
// Usage: node provision.mjs <mcpBase> <outDir>
//   env: ADMIN_CREDENTIAL, AD4M_EMAIL, AD4M_PASSWORD, AD4M_USER_EMAIL,
//        AD4M_USER_PASSWORD, AD4M_CHANNEL, AD4M_WS_URL, LINK_SERVER_URL,
//        SERVER_LINK_BUNDLE (a path inside the executor container), AD4M_SDK

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { McpClient, pick } from './mcp-client.mjs'

const [mcpBase, outDir] = process.argv.slice(2)
const ADMIN = process.env.ADMIN_CREDENTIAL || 'windtunnel-admin'
const HEX = { email: process.env.AD4M_EMAIL || 'sovereign-wt@agent.local', pass: process.env.AD4M_PASSWORD || 'sovereign-wt-pass-123' }
const ALEX = { email: process.env.AD4M_USER_EMAIL || 'alex-wt@agent.local', pass: process.env.AD4M_USER_PASSWORD || 'alex-wt-pass-123' }
const CHANNEL = process.env.AD4M_CHANNEL || 'swt-ad4m://channel'
const WS_URL = process.env.AD4M_WS_URL || 'http://ad4m:12000'
const LINK_SERVER = process.env.LINK_SERVER_URL || 'http://link-server:3456'
const BUNDLE = process.env.SERVER_LINK_BUNDLE || '/opt/ad4m/server-link-language/bundle.js'
const SDK = process.env.AD4M_SDK || '/sdk/index.js'

if (!mcpBase || !outDir) {
  console.error('usage: provision.mjs <mcpBase> <outDir>')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`[swt-provision] ${m}`)

async function waitForNode(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const c = new McpClient(base, ADMIN)
      await c.initialize('swt-provision-probe')
      return c
    } catch {
      await sleep(2000)
    }
  }
  throw new Error(`ad4m node MCP at ${base} never became ready`)
}

/** Sign a user up and log in. MCP answers `initialize` before the executor has
 *  its token-signing key, so login can fail with "main key not found" for a
 *  while: retry until a JWT lands. */
async function userJwt(admin, { email, pass }) {
  for (let i = 0; i < 40; i++) {
    try {
      await admin.callToolJson('signup', { email, password: pass })
    } catch {
      /* the user may already exist */
    }
    let login
    try {
      login = await admin.callToolJson('login_email', { email, password: pass })
    } catch (e) {
      login = { error: String(e?.message ?? e) }
    }
    const jwt = pick(login, 'token', 'jwt', 'access_token')
    if (jwt) return jwt
    if (i % 5 === 0) log(`waiting for token key… (${JSON.stringify(login).slice(0, 120)})`)
    await sleep(3000)
  }
  throw new Error(`no JWT for ${email} after retries (node never finished key generation)`)
}

/** Poll `fn` until it returns a truthy value or `ms` pass. */
async function until(label, fn, ms = 30000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) {
      last = e
    }
    await sleep(1000)
  }
  throw new Error(`timed out: ${label} (${last?.message ?? JSON.stringify(last)?.slice(0, 200)})`)
}

;(async () => {
  const { Ad4mClient, Perspective, Link, LinkQuery } = await import(SDK)
  const admin = await waitForNode(mcpBase)
  const hexJwt = await userJwt(admin, HEX)
  const alexJwt = await userJwt(admin, ALEX)

  const root = new Ad4mClient(WS_URL, ADMIN)
  const hex = new Ad4mClient(WS_URL, hexJwt)
  const alex = new Ad4mClient(WS_URL, alexJwt)
  const hexDid = (await hex.agent.me()).did
  const alexDid = (await alex.agent.me()).did
  if (!hexDid || !alexDid || hexDid === alexDid) throw new Error(`two distinct agents expected: ${hexDid} / ${alexDid}`)
  log(`Hex ${hexDid}, Alex ${alexDid}`)

  // The server-link-language, published once on the node, then templated per
  // neighbourhood with the link-server's URL and a fresh UID (as WE does).
  const template = await root.languages.publish(BUNDLE, {
    name: 'server-link-language',
    description: 'Links through the wind tunnel link-server',
    possibleTemplateParams: ['SERVER_URL', 'UID', 'name', 'description']
  })
  const channelPerspective = await hex.perspective.add('swt-ad4m-channel')
  const linkLanguage = await hex.languages.applyTemplateAndPublish(
    template.address,
    JSON.stringify({ SERVER_URL: LINK_SERVER, UID: randomUUID(), name: 'swt-ad4m-channel' })
  )
  const neighbourhoodUrl = await hex.neighbourhood.publishFromPerspective(
    channelPerspective.uuid,
    linkLanguage.address,
    new Perspective([])
  )
  log(`published ${neighbourhoodUrl} (server-link ${linkLanguage.address} → ${LINK_SERVER})`)

  const joined = await alex.neighbourhood.joinFromUrl(neighbourhoodUrl)
  const alexUuid = await until('Alex sees the neighbourhood', async () => {
    const all = await alex.perspective.all()
    return all.find((p) => p.sharedUrl === neighbourhoodUrl)?.uuid ?? joined?.uuid
  })

  // Alex's write must reach Hex's view, with Alex as its author.
  const probe = `swt-ad4m://probe/${randomUUID()}`
  await alex.perspective.addLink(alexUuid, new Link({ source: probe, predicate: 'swt-ad4m://probe', target: CHANNEL }))
  const seen = await until('Hex sees Alex’s probe link', async () => {
    const links = await hex.perspective.queryLinks(channelPerspective.uuid, new LinkQuery({ source: probe }))
    return links?.[0]
  })
  if (seen.author !== alexDid) throw new Error(`probe link authored by ${seen.author}, expected Alex ${alexDid}`)
  log(`Alex's probe reached Hex's perspective (same perspective: ${alexUuid === channelPerspective.uuid})`)

  const manifest = {
    jwt: hexJwt,
    did: hexDid,
    uuid: channelPerspective.uuid,
    channel: CHANNEL,
    neighbourhoodUrl,
    linkLanguage: linkLanguage.address,
    user: { name: 'Alex', jwt: alexJwt, did: alexDid, uuid: alexUuid }
  }
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'ad4m-token.json'), JSON.stringify({ token: hexJwt }))
  fs.writeFileSync(path.join(outDir, 'provision.json'), JSON.stringify(manifest, null, 2))
  log(`wrote token + manifest to ${outDir}`)
  process.exit(0)
})().catch((e) => {
  console.error('[swt-provision] FATAL', e?.stack || e)
  process.exit(1)
})
