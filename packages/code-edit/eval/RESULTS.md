# Symbol edit — does editing by name help coding agents?

_Sections 1–3 were written and committed before any scored run: GraphCoder commit `240b24f` (`eval/symbol-edit/RESULTS.md`), when the tool lived in GraphCoder as `mcp__graphcoder__edit`. They are copied here unchanged. The tool has since moved to Sovereign as `@sovereign/code-edit` (`mcp__code__edit`) with the same engine; the 2026-09-26 run used the GraphCoder build named in §3. Sections 4–7 follow the runs._

## 1. Question

Does giving an agent `mcp__graphcoder__edit`, with one line of steering toward it, cut failed edit calls and output tokens on real repository changes without lowering the rate of solved tasks?

## 2. Hypothesis

Predictions, per claim, with the mechanism behind each:

| # | Claim | Prediction | Mechanism |
| --- | --- | --- | --- |
| H1 | Adoption | Opus sends at least half of its edits through `mcp__graphcoder__edit`. The local model sends fewer, between a quarter and a half. | One appended line steers Opus reliably; the local model follows appended instructions less well and keeps to the tools Claude Code describes at length. |
| H2 | Failed edit calls | Both models fail fewer edit calls with the tool. The drop is larger for the local model. | Built-in Edit fails when `old_string` does not match exactly or the file was not Read first. Small models miss exact matches more often. Naming a symbol avoids both. |
| H3 | Output tokens | Opus writes about 10% fewer output tokens with the tool; the local model writes fewer too. | `replace` sends new code once, where Edit sends old and new text. Most task edits are small, so the saving stays modest. |
| H4 | Solved tasks | No arm with the tool solves fewer tasks than its base arm. The local model may solve more. | The tool rejects edits that break syntax before they land, so fewer runs spend turns repairing a broken file. |

The most likely way the whole hypothesis fails: H1 fails for both models. Claude Code's own Edit carries a long description and system-prompt guidance; one appended line may not move either model, and then H2–H4 have nothing to measure.

## 3. Method

**Tasks.** Commits from the Sovereign repository, 2026-08-01 onward, newest first. A commit qualifies when it changes 1–3 source files under `packages/*/src` (≤ 80 changed lines) plus at least one test file, and nothing else except docs; its tests must fail on the parent commit and pass with the commit's source change applied. The first 20 that qualify form the set (`tasks.json`; rejected candidates and reasons in `tasks.rejected.json`).

**Setup per task.** A clone holding only the parent commit, so no answer sits in its history; dependencies installed, every package built, codegraph index created; the task's tests committed on top. The prompt gives the commit's subject and body, names the tests and the command to run them, and forbids changing the tests.

**Conditions.**

| Arm | Model | Tools beyond Claude Code's built-ins | Runs |
| --- | --- | --- | --- |
| opus-base | claude-opus-5-5 | codegraph MCP | 20 |
| opus-edit | claude-opus-5-5 | codegraph MCP, graphcoder `edit`, one steering line | 20 |
| local-base | local model (KAT-Coder-V2.5-Dev on llama.cpp, via LiteLLM) | codegraph MCP | 20 |
| local-edit | same | codegraph MCP, graphcoder `edit`, one steering line | 20 |

**Controls.** Each base arm is the control for its edit arm: same model, same checkout state, same prompt, same other tools; only the graphcoder server and the steering line differ. The two arms of a task run on the same checkout, reset between them; which arm runs first alternates by task, so an order effect (for example, a warm llama.cpp prompt cache) cannot favour one arm. `--setting-sources project` keeps the user's CLAUDE.md, hooks and memory out of every run.

**Scoring.** After each run the test files are restored, then run: the task counts as solved when they pass. Metrics per run, from the CLI transcript: edit calls (Edit, MultiEdit, Write, NotebookEdit, `mcp__graphcoder__edit`), failed edit calls, graphcoder share of edit calls, Read calls, Bash commands that write files (heredocs, redirects, `sed -i`, scripts; scratch files included), turns, output tokens. Limits per run: 60 turns; 20 minutes (Opus) or 60 minutes (local).

**Method tested:** `mcp__graphcoder__edit` at GraphCoder `feat/symbol-edit` (engine in `packages/core/src/edit`), deployed as `graphcoder-mcp --tools edit`.
