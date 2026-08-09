// Scenario interface — each wind-tunnel scenario implements this.

import type { SovereignClient } from './client.js'

export interface ScenarioContext {
  /** Pre-connected HTTP + WS client pointed at the Sovereign instance. */
  client: SovereignClient
  /** Base URL of the mock LLM (for assertions on request log, script injection). */
  mockLlmUrl: string
  /** Base URL of the Sovereign instance. */
  sovereignUrl: string
  /** Absolute path to the docker-compose.yml used for this run. */
  composeFile: string
}

export interface ScenarioResult {
  /** Hard pass/fail — gates the runner exit code. */
  passed: boolean
  /** One-line human-readable verdict. */
  summary: string
  /** Arbitrary metrics for reporting. */
  metrics: Record<string, unknown>
  /** Individual timed operations. */
  samples: Array<{ name: string; durationMs: number; error?: string }>
}

export interface Scenario {
  /** Short id (e.g. "s1", "s3"). */
  id: string
  /** Human-readable name. */
  name: string
  /** One-line description of what the scenario proves. */
  description: string
  /** Run the scenario and return results. */
  run(ctx: ScenarioContext): Promise<ScenarioResult>
}
