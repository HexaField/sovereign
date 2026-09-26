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

## 4. Results

Run: 2026-09-26, 20 tasks, 4 arms, 80 runs. No run timed out. Every edit arm connected to the graphcoder server (40/40).

### Per arm (pre-registered metrics)

| Arm | Solved | Edit calls (mean) | Failed edit calls (total) | graphcoder share of edit calls | Read calls (mean) | Output tokens (median) | Turns (median) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| opus-base | 20/20 | 0.1 | 0 | – | 0.0 | 1,854 | 6 |
| opus-edit | 20/20 | 0.1 | 0 | **0%** | 0.0 | 1,752 | 5 |
| local-base | **20/20** | 3.4 | 3 | – | 5.9 | 2,583 | 23 |
| local-edit | **17/20** | 3.6 | 6 | **11%** (8 of 72) | 4.0 | 2,612 | 24 |

### Paired, same task

| Model | Pairs | Solved by base only | Solved by edit only | Fewer failed edits with the tool | More failed edits with the tool | Output tokens, edit ÷ base (median) |
| --- | --- | --- | --- | --- | --- | --- |
| Opus | 20 | 0 | 0 | 0 | 0 | 0.93 |
| Local | 20 | 3 | 0 | 3 | 3 | 1.16 |

### Verdict per claim

| # | Claim | Prediction | Result | Verdict |
| --- | --- | --- | --- | --- |
| H1 | Adoption | Opus ≥ 50%; local 25–50% | Opus 0% (0 calls); local 11% (8 calls, in 3 of 20 runs) | **Refuted** for both models |
| H2 | Fewer failed edit calls | Both fewer; local drops more | Opus 0 vs 0. Local 3 → 6 | **Refuted.** Opus: nothing to measure. Local: more, not fewer |
| H3 | Fewer output tokens | Opus about 10% fewer; local fewer | Opus median ratio 0.93; local 1.16 | **Not supported.** Opus changed nothing it could cause (0 calls); local wrote more |
| H4 | No drop in solved tasks | Edit arms ≥ base arms | Opus 20 = 20; local 17 < 20 | **Holds for Opus. Refuted for local** |

### The graphcoder calls themselves

| Measure | Value |
| --- | --- |
| Calls (all in local-edit) | 8 |
| Runs that used the tool | 3 of 20 |
| Calls that succeeded | 6 |
| Calls rejected | 2 |
| Rejections that were correct | **2 of 2.** Both sent a truncated function (unbalanced braces); the TypeScript compiler's parser rejects the same code |
| Runs lost where the tool was used | 0 (all 3 solved) |

### Failed or suspect runs

| Task | Arm | Tests at the end | Stop | Turns | graphcoder calls | What happened |
| --- | --- | --- | --- | --- | --- | --- |
| 75012ff0 | local-edit | 2 failed, 66 passed | turn limit | 61 | 0 | 139 Bash calls; ran out of turns. Base solved it in 105 turns (base had no turn limit hit) |
| add5cd9d | local-edit | 1 failed, 51 passed | success | 78 | 0 | 20 built-in Edits, 2 failed. Base solved it in 11 turns. The same task passed in the pilot's edit arm |
| 51c15c32 | local-edit | 1 failed, 61 passed | success | 197 | 0 | 194 Bash calls, no file changed; the model looped. Base solved it in 40 turns |

None of the three failed runs called the tool.

### Post-hoc metric (added after seeing the data)

The pre-registered "failed edit calls" counts Edit, Write and graphcoder calls. Opus made its edits with Bash scripts instead, so this table counts Bash commands that write files, and how many failed.

| Arm        | Bash file-write commands | Failed |
| ---------- | ------------------------ | ------ |
| opus-base  | 28                       | 0      |
| opus-edit  | 24                       | 0      |
| local-base | 2                        | 0      |
| local-edit | 14                       | 4      |

### Pilot (one task, not part of the scored run)

Task add5cd9d, local model, before the analyzer fixes (e616d2c).

| Arm        | Solved | Turns | Output tokens | graphcoder calls                                                 |
| ---------- | ------ | ----- | ------------- | ---------------------------------------------------------------- |
| local-base | yes    | 35    | 24,522        | –                                                                |
| local-edit | yes    | 20    | 5,958         | 1, failed: a false syntax error on valid code (fixed in e616d2c) |

## 5. Conclusion

The tool changed almost nothing because the models almost never called it. Opus runs under `bypassPermissions`, and in that mode Claude Code tells the model to prefer Bash, `cat`, `sed` and short scripts over Read, Edit and Write. Opus followed that instruction in both arms: 0 Read calls, 0 graphcoder calls, edits by `python3 -` scripts. One appended line of steering did not outweigh it. The local model called the tool in 3 runs of 20. Its three lost tasks never called the tool, so the tool did not cause them. The most likely cause is the local model's run-to-run variance: add5cd9d failed here and passed in the pilot's edit arm. The steering line and the extra tool description may also add load that a small model handles badly. One run per task cannot separate these two causes.

## 6. Next step

1. Test adoption, not the edit engine. Run Opus without `bypassPermissions` (default mode, `--allowedTools` for the tools the task needs), with and without the tool, on the same 20 tasks. This isolates the Claude Code instruction as the cause of H1.
2. Rerun the local model 3 times per task per arm, to measure its variance before any claim about H4.
3. Keep the tool deployed. When the tool was called, it did no harm: it rejected 2 corrupting edits correctly and lost no task.

## 7. Limits

- n = 20 tasks, one run per task per arm. The local model's 3-task gap is inside its likely run-to-run variance. The pilot passed a task that failed here.
- All tasks come from one repository (Sovereign, TypeScript), in 1–3 files, with at most 80 changed lines. Large refactors, where editing by name should help most, were not tested.
- Adoption was measured under `bypassPermissions` only. That mode actively steers the model away from edit tools. Every Sovereign session runs in it, so the result holds for Sovereign today, not for Claude Code in general.
- The 8 tool calls cannot show whether editing by name reduces failures. The sample is too small.
- The local lane ran on the graphcoder build named in §3; Sovereign now ships the same engine as `@sovereign/code-edit`, with later fixes (strict input, session roots) that do not change edit behaviour.
- The post-hoc metric was chosen after the data was seen.
- **Most plausible refutation:** in default permission mode Opus may adopt the tool at a high rate and cut tokens as H1 and H3 predicted; this run cannot tell, because the mode suppressed all edit tools.
