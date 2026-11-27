# Subagent harnesses (`packages/agent-backend/src/harness/`)

`agents_spawn { task, cwd?, harness?, model?, label? }` (cwd required for a non-claude harness) runs a task in a named **harness profile**. A profile with adapter `claude` takes the SDK path in `packages/agent-backend/AGENTS.md` (Claude Agent SDK + model catalog: `spawnSubagent`). Every other profile goes through one shared runner (`runner.ts`) and a small adapter per CLI (`adapters/`). The tool description lists the configured profiles (`describeProfiles`: adapter, model, endpoint or own login, MCP or not). The profile comes from the call's `harness`, else `agentBackend.subagentDefaults.harness`, else `claude`. An unknown name fails with the configured list. The cap of 4 running children per parent counts every harness together.

## Config (`agentBackend.harnesses`, `agentBackend.endpoints`)

```jsonc
"harnesses": {
  "claude": { "adapter": "claude" },
  "devin":  { "adapter": "devin", "model": "swe-2-high", "sandbox": "harness",
              "allowedRoots": ["~/workspaces/coasys"], "configFile": "~/.config/devin/executor.json", "mcp": true },
  // examples, not defaults:
  "pi-local":  { "adapter": "pi", "endpoint": "studio", "model": "qwen3-coder", "allowedRoots": ["~/workspaces"] },
  "oc-cloud":  { "adapter": "opencode", "endpoint": "cloud", "model": "some/model", "allowedRoots": ["~/workspaces/coasys"] }
},
"endpoints": {
  "studio": { "api": "openai", "baseUrl": "http://studio.example:8080/v1", "local": true },
  "cloud":  { "api": "openai", "baseUrl": "https://llm.example/v1", "apiKeySecret": "cloudKey", "local": false }
}
```

- Profile fields: `adapter` (`claude` \| `devin` \| `codex` \| `opencode` \| `pi`), `bin`, `model`, `endpoint`, `sandbox` (`harness` \| `bwrap` \| `none`, default `bwrap`), `allowedRoots`, `mcp` (default true), `configFile`, `extraArgs`, `extraEnv`, `timeoutMinutes`. Types, defaults and schema live in `packages/config/src/{types,defaults,schema}.ts`, and all three change together.
- The defaults are `claude` and `devin`; `endpoints` defaults to `{}`. Codex, OpenCode and Pi need an endpoint (their per-run config dirs hide the user's own logins), so they get profiles only once one is configured.
- An endpoint names its key by **secret name** (`apiKeySecret`, a key in the secret store `data/secrets.json`), never the key itself. The runner reads it at spawn and passes it only in the child's env as `SOVEREIGN_ENDPOINT_API_KEY`. Config files the adapters write reference that variable (`{env:…}`, `env_key`, Pi's env-var-name `apiKey`), so the key is never written to disk. A missing secret fails the spawn.
- `local: true` marks an endpoint whose requests stay on the user's machines. Only a local endpoint with a non-remote adapter may run in a private root (`~/.sovereign`, `~/workspaces/hexafield`, `PRIVATE_ROOTS`).
- The config is read at each spawn, so a change applies to the next run without a restart.

## Runner rules (in code, every non-claude run)

- **cwd guard** (`resolveHarnessCwd`): the cwd is required. Its real path must sit under the profile's `allowedRoots`. The data and config dirs are always refused, and the private roots are refused unless the endpoint is local.
- **Env allowlist** (`filterEnv`): PATH, HOME, USER, LOGNAME, SHELL, LANG, LC*ALL, TERM, TMPDIR, TZ, XDG*\*: no token or SSH agent socket. Then the endpoint key, then `extraEnv`.
- **Sandbox.** `bwrap` (default) runs the CLI with `/` read-only. It masks the credential paths (`.ssh`, `.gnupg`, `.config/gh`, `.aws`, `.claude*`, `.codex`, `.pi`, opencode, devin, `.sovereign`, …), the data and config dirs and, for a non-local endpoint, the private roots. `~/.cache`, the adapter's own state dirs, the cwd, the run dir and the kept dir stay writable. Only paths that exist are masked. `harness` uses the CLI's own sandbox (Devin's `--sandbox`; only adapters with `ownSandbox`). That sandbox does not cover the MCP servers the CLI starts, so the runner wraps each stdio MCP server in bwrap itself. `none` is for tests.
- **Brief** (`buildHarnessBrief`): a never-commit / report-format header and the MCP server list (or "no MCP"), then `buildSubagentSystemPrompt`, then the task.
- **Files.** The per-run dir (`/tmp/sovereign-harness-*`, 0700: brief and the CLI's config) is deleted when the run ends. The kept dir `<dataDir>/agent-backend/harness/<key>/` holds `output.log`, `stderr.log` (when non-empty), the export and the CLI's session data, and the report names it as `Transcript:`.
- **Lifecycle.** Each run is its own process group (stop and timeout kill the group, SIGKILL after a grace). A non-zero exit, or an exit with no answer, fails the run with the stderr tail. `runs.json` makes a restart report cut-off runs failed (`recoverInterrupted`).
- **Events, as a Claude subagent's.** At spawn the runner emits `session.info`, `subagent.spawned` and `chat.status` working, and adds the run to `active-sessions.json` under its parent. Text adapters (`textStdout`: Devin, Pi) stream stdout as `chat.stream`. At the end it emits the report as a `chat.turn`, then idle, then `subagent.completed` or `subagent.failed` with `parentMessage` (`formatSubagentResult`), `label`, `durationMs` and `result` or `error` (`ended: stopped | timed-out` when cut off), and drops the active-sessions entry. Wiring's `subagent.completed`/`failed` listener (`deliverToParent`) is the one path to the parent: the runner delivers nothing itself.
- **The harness backend** (`backend.ts`, kind `harness`) owns `harness-<uuid>` keys (`ownsSession`): routing checks owners before the registry, lists them in `all()` and relays their events, so the subagent card, list and session view work unchanged. `forKind`, `statusAll` and `/api/backends` leave it out. Its history is the task as the user turn, then the adapter's `transcript` (Devin's ATIF export, Codex and OpenCode JSON stdout; `transcript.ts`), else stdout, then the report and, on failure, an `agent-error` system turn. A running run's last turn streams. Each run's state is `run.json` in its kept dir, so finished runs stay listed after a restart. `abort` and `stopSubagent` stop the run; `sendMessage`, `createSession` and `setSessionModel` fail with the reason.

## Adapters

| Adapter | Command | Endpoint | MCP | Sandbox |
| --- | --- | --- | --- | --- |
| devin | `devin --config <configFile> -p --prompt-file <brief> --model <m> [--sandbox] --export <file>` | none: Devin's own login | yes: `XDG_CONFIG_HOME=<run>/config` → `devin/mcp_config.json` | `harness` (default profile) or bwrap |
| codex | `codex exec --skip-git-repo-check --json -o <last> -C <cwd> -` (brief on stdin) | `openai` only (`wire_api = "responses"`) | yes: `[mcp_servers.*]` in `CODEX_HOME/config.toml` | bwrap (`sandbox_mode = danger-full-access` inside it) |
| opencode | `opencode run --format json -m sovereign/<m> --dir <cwd> <brief>` | `openai` (`@ai-sdk/openai-compatible`) or `anthropic` | yes: `mcp` in `OPENCODE_CONFIG` | bwrap |
| pi | `pi -p --provider sovereign --model <m> --session-dir <kept>/sessions --no-context-files @<brief> "…"` | `openai-completions` or `anthropic-messages` in `PI_CODING_AGENT_DIR/models.json` | **none**: Pi 0.73 has no MCP | bwrap |

The subagent MCP set (`harnessMcpServers` in `mcp.ts`) is the Claude subagent's: codegraph, semble, `code` with `--edit-roots` set to exactly the run's cwd, and `sovereign` at `/api/mcp/subagent`. It is converted to the neutral `McpServerSpec` (`stdio` \| `http`) that each adapter writes in its own format. `mcp: false` on a profile turns it off. The `sovereign` server (its `embeddings_search` reads the user's private notes) goes only to runs whose endpoint is `local` and whose harness calls no remote service; Devin and cloud endpoints get codegraph, semble and code.

## Gotchas

- **Devin trust.** `devin -p` refuses an untrusted directory and ignores `respect_workspace_trust` in a `--config` file, so every run adds its cwd to `~/.local/share/devin/cli/trusted_workspaces.json`. The executor config (`configFile`, outside the repo) must exist. It turns off Devin's import of other agents' configs and attribution and denies push/remote/gh/ssh-style commands. Devin is `remote`: it never runs in a private root, even on a local endpoint.
- **OpenCode JSON output.** It emits one event per line: `text` (the answer parts, `part.messageID`), `tool_use`, `step_start`, `step_finish` and `reasoning`. `error` events go to **stdout** in JSON mode, not stderr, and the process exits 1, so `opencodeReport` surfaces them. A permission the config leaves at `ask` (such as `external_directory`, a path outside `--dir`) is auto-rejected in `run`.
- **OpenCode's system prompt is ~7.5k tokens.** A model with an 8k context window reads one file and stalls, so use a local model with at least 32k context.
- **Codex** warns that it cannot create its PATH helper aliases when `CODEX_HOME` sits under a temporary dir, and proceeds. It needs no OpenAI login with a custom `model_provider`. For a model id it has no metadata for, it logs a fallback-metadata `error` item, which is harmless.
- **Pi** takes `apiKey` as an env var name first. `--no-context-files` keeps it from loading `AGENTS.md` a second time (the brief already has it).
- **`<dataDir>/agent-backend/devin/runs.json`** of the old executor is no longer read.
