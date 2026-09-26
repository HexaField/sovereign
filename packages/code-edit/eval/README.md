# Symbol edit evaluation

Does editing code by symbol name (`mcp__code__edit`, this package) cut failed edits and output tokens for coding agents, compared with Claude Code's built-in Edit alone? Results and the write-up: [RESULTS.md](RESULTS.md).

## How it works

1. **Tasks** (`select-tasks.mjs`). Take commits from a target repo that change 1–3 source files (≤ 80 changed lines) together with at least one test, and nothing else except docs. A commit becomes a task only when its tests, dropped onto the parent commit, fail — and pass once the commit's source change is applied.
2. **Checkouts** (`lib.mjs`). Each task runs in a clone that holds only the parent commit (`git clone --depth 1 --revision`), so its history holds no answer. Submodules come from the source repo's objects, dependencies install offline, native builds are borrowed from the source checkout, every workspace package is built (vitest resolves them from `dist/`), and codegraph indexes the clone. The task's tests are committed on top, so each arm starts from the same `HEAD`.
3. **Arms** (`run.mjs`). One lane per model; each lane runs both of its arms on the same checkout, resetting in between and alternating which arm goes first.

   | Arm | Model | MCP servers | Extra system prompt |
   | --- | --- | --- | --- |
   | `opus-base` | claude-opus-5-5 | codegraph | – |
   | `opus-edit` | claude-opus-5-5 | codegraph, code (this checkout's `dist/mcp.js`) | one line steering toward `mcp__code__edit` |
   | `local-base` | local model via LiteLLM (`qwen3.8-27b` alias) | codegraph | – |
   | `local-edit` | same | codegraph, code | same line |

   Every run uses the Claude Code CLI with `--setting-sources project` (no user CLAUDE.md, hooks or memory), `--strict-mcp-config`, `--permission-mode bypassPermissions`, `--max-turns 60`, and default effort. The prompt states the commit's subject and body, names the tests and how to run them, and forbids changing the tests.

4. **Scoring.** After a run the test files are restored from `HEAD`, then run. `pass` = they pass. Metrics come from the CLI's `stream-json` transcript: edit calls (Edit, MultiEdit, Write, NotebookEdit, `mcp__code__edit`), failed edit calls (tool results marked as errors), Read calls, Bash commands that write files (heredocs, redirects, `sed -i`, scripts; scratch files included), turns, output tokens.
5. **Report** (`report.mjs`) writes `summary.md`: per arm, per task, paired base-vs-edit, and every failed or suspect run.

## Run it

```bash
node select-tasks.mjs --repo ~/workspaces/org/repo --count 20 --out tasks.json
node run.mjs --tasks tasks.json --out results/<id> --lane opus  --repo <repo> --claude <claude binary>
node run.mjs --tasks tasks.json --out results/<id> --lane local --repo <repo> --claude <claude binary>
node report.mjs --out results/<id>
```

Lanes can run at the same time; each has its own checkouts. A rerun skips (task, arm) pairs already in `runs.jsonl`. The local lane needs LiteLLM on `:4000`; the edit arms need this package built (`pnpm --filter @sovereign/code-edit build`) and `codegraph` on `PATH`.
