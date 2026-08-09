#!/usr/bin/env -S npx tsx
// Sovereign Wind Tunnel — runner.
//
// SAFETY: All scenarios run inside Docker containers only.
// The runner NEVER connects to production Sovereign.
// No --native flag exists — removed by design.
//
// Usage:
//   npx tsx src/main.ts                       # run all scenarios
//   npx tsx src/main.ts --scenario s1         # run one scenario
//   npx tsx src/main.ts --scenario s1,s3      # run specific scenarios
//   npx tsx src/main.ts --sovereign-url ...   # custom endpoint (container)
//   npx tsx src/main.ts --mock-llm-url ...    # custom mock LLM (container)

import { SovereignClient } from './client.js'
import { ALL_SCENARIOS } from './scenarios/index.js'
import type { ScenarioResult } from './scenario.js'

// ── Config ──────────────────────────────────────────────────────────
const args = process.argv.slice(2)

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : (process.env[name.toUpperCase().replace(/-/g, '_')] ?? fallback)
}

const sovereignUrl = getArg('sovereign-url', 'http://localhost:5811')
const mockLlmUrl = getArg('mock-llm-url', 'http://localhost:8900')
const scenarioFilter = getArg('scenario', '')
const jsonOutput = args.includes('--json')
const composeFile = getArg('compose-file', new URL('../docker/docker-compose.yml', import.meta.url).pathname)

// Hard guard: reject any attempt to point at production Sovereign.
// Port 5801 serves the live instance on the host.
if (sovereignUrl.includes(':5801')) {
  console.error('✗ REFUSED — sovereign-url points at port 5801 (production).')
  console.error('  The wind tunnel MUST run against isolated Docker containers only.')
  console.error('  Use ./run.sh (Docker mode) or override --sovereign-url to a container port.')
  process.exit(1)
}

// ── Scenario selection ──────────────────────────────────────────────
const selectedIds = scenarioFilter ? scenarioFilter.split(',').map((s) => s.trim()) : []
const scenarios = selectedIds.length > 0 ? ALL_SCENARIOS.filter((s) => selectedIds.includes(s.id)) : ALL_SCENARIOS

if (scenarios.length === 0) {
  console.error(`No scenarios matched filter: ${scenarioFilter}`)
  console.error(`Available: ${ALL_SCENARIOS.map((s) => s.id).join(', ')}`)
  process.exit(1)
}

// ── Wait for services ───────────────────────────────────────────────
async function waitForService(url: string, label: string, timeoutMs = 60000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`${label} at ${url} failed to respond within ${timeoutMs}ms`)
}

// ── Run ─────────────────────────────────────────────────────────────
interface RunResult {
  id: string
  name: string
  result: ScenarioResult | null
  error?: string
  durationMs: number
}

async function run(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║              Sovereign Wind Tunnel                         ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()
  console.log(`  Sovereign:  ${sovereignUrl}`)
  console.log(`  Mock LLM:   ${mockLlmUrl}`)
  console.log(`  Scenarios:  ${scenarios.map((s) => s.id).join(', ')}`)
  console.log()

  // Wait for both services
  console.log('⏳ Waiting for services...')
  try {
    await waitForService(sovereignUrl, 'Sovereign')
    console.log('  ✓ Sovereign ready')
  } catch (err: any) {
    console.error(`  ✗ Sovereign not reachable: ${err.message}`)
    process.exit(1)
  }

  try {
    await waitForService(mockLlmUrl, 'Mock LLM')
    console.log('  ✓ Mock LLM ready')
  } catch (err: any) {
    console.error(`  ✗ Mock LLM not reachable: ${err.message}`)
    process.exit(1)
  }
  console.log()

  // Run scenarios sequentially
  const results: RunResult[] = []
  let passed = 0
  let failed = 0

  for (const scenario of scenarios) {
    const client = new SovereignClient(sovereignUrl)
    const label = `[${scenario.id}] ${scenario.name}`

    process.stdout.write(`  ▶ ${label}... `)
    const start = performance.now()

    let result: ScenarioResult | null = null
    let error: string | undefined

    try {
      result = await scenario.run({
        client,
        mockLlmUrl,
        sovereignUrl,
        composeFile
      })
    } catch (err: any) {
      error = err?.message ?? String(err)
      result = null
    }

    const durationMs = performance.now() - start
    results.push({ id: scenario.id, name: scenario.name, result, error, durationMs })

    if (result?.passed) {
      passed++
      console.log(`✓ ${result.summary} (${Math.round(durationMs)}ms)`)
    } else if (error) {
      failed++
      console.log(`✗ CRASHED: ${error} (${Math.round(durationMs)}ms)`)
    } else {
      failed++
      console.log(`✗ FAILED: ${result?.summary ?? 'no result'} (${Math.round(durationMs)}ms)`)
    }

    // Clean up WS if the scenario left it open
    try {
      client.disconnectWs()
    } catch {
      /* ignore */
    }
  }

  // Summary
  console.log()
  console.log('─'.repeat(62))
  console.log(`  Results: ${passed} passed, ${failed} failed, ${results.length} total`)
  console.log('─'.repeat(62))

  // Latency report
  if (!jsonOutput) {
    console.log()
    console.log('  Latency samples:')
    for (const r of results) {
      if (!r.result?.samples.length) continue
      console.log(`    [${r.id}]`)
      for (const s of r.result.samples) {
        const status = s.error ? `✗ ${s.error}` : '✓'
        console.log(`      ${s.name}: ${Math.round(s.durationMs)}ms ${status}`)
      }
    }
  }

  // JSON output
  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2))
  }

  process.exit(failed > 0 ? 1 : 0)
}

run().catch((err) => {
  console.error('Fatal:', err)
  process.exit(2)
})
