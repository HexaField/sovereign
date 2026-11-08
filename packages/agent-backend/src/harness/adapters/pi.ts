// Pi (@mariozechner/pi-coding-agent 0.73). `pi -p --provider sovereign
// --model <m> @<brief> …` with PI_CODING_AGENT_DIR pointing at a per-run dir
// whose models.json defines the provider. Pi has no MCP ("No MCP." in its
// README): a Pi run gets its built-in tools only.

import fs from 'node:fs'
import path from 'node:path'
import { ENDPOINT_KEY_ENV, plainText, requireEndpoint, requireModel, type HarnessAdapter } from '../adapter.js'

export const piAdapter: HarnessAdapter = {
  id: 'pi',
  bin: 'pi',
  remote: false,
  mcp: false,
  ownSandbox: false,

  prepare(run) {
    const endpoint = requireEndpoint(run, 'pi')
    const model = requireModel(run, 'pi')
    const agentDir = path.join(run.dir, 'pi')
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 })
    const models = {
      providers: {
        sovereign: {
          baseUrl: endpoint.baseUrl,
          api: endpoint.api === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
          // Pi reads `apiKey` as an env var name first: the key stays in the env.
          apiKey: endpoint.apiKey ? ENDPOINT_KEY_ENV : 'none',
          ...(endpoint.api === 'openai'
            ? { compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } }
            : {}),
          models: [{ id: model }]
        }
      }
    }
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(models, null, 2), { mode: 0o600 })
    return {
      command: run.bin,
      args: [
        '-p',
        '--provider',
        'sovereign',
        '--model',
        model,
        '--session-dir',
        path.join(run.keepDir, 'sessions'),
        '--no-context-files',
        ...(run.profile.extraArgs ?? []),
        `@${run.briefFile}`,
        'Carry out the task in the brief above.'
      ],
      env: { ...run.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' }
    }
  },

  report(stdout) {
    return plainText(stdout).trim()
  },

  textStdout: true
}
