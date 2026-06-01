# Pi as the Principled Successor to Claude Code — Specification

**Status:** Draft **Revision:** 1 **Date:** 2026-06-01

Pi is not just a different agent runtime than OpenClaw or Claude Code. It is a different **doctrine** about what an agent harness is allowed to do to its operator's context, how it should be extended, and what role the LLM plays in software construction. This spec extracts that doctrine from [its primary source](references/pi-mario-zechner-talk-2025.md), validates it against [PRINCIPLES.md](../PRINCIPLES.md), identifies where Sovereign's current plans don't yet honour it, and proposes the additions required so that adopting Pi as Sovereign's primary agent backend lands the doctrine — not just the library.

This document conforms to [PRINCIPLES.md](../PRINCIPLES.md). Requirements use MUST/MUST NOT/SHOULD/SHOULD NOT/MAY per [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

**Companion specs:**

- [un-openclawing-spec.md](archive/un-openclawing-spec.md) — the abstract `AgentBackend` seam (prerequisite).
- [pi-migration-spec.md](pi-migration-spec.md) — the mechanical migration from OpenClaw to Pi as a backend implementation.
- [claude-code-adapter-spec.md](archive/claude-code-adapter-spec.md) — Claude Code as a coexisting backend.

This spec is **upstream of all three** in the sense that it gives them shared intent. Where this spec and the migration spec disagree, this spec wins; the migration spec must be amended.

---

## 1. The Doctrine — Eight Theses

These are not engineering preferences. They are commitments about how Sovereign treats the agent, the operator, and the code being produced. Each thesis is annotated with its source in the talk and with the Sovereign principle it most strongly aligns with.

### Thesis 1 — Context sovereignty

> "My context wasn't my context. Claude Code is the thing that controls my context. And behind my back, Claude Code does things to the context."

The agent's context window is the operator's working memory. The harness MUST NOT mutate it invisibly. Every system prompt, every tool definition, every system reminder, every compaction artifact, every injected document MUST be observable to the operator and reversible without restart. Behaviour that worked yesterday MUST work today unless the operator chose the change.

Aligns with PRINCIPLES.md §5 (Single Source of Truth), §6 (File-Driven), §7 (Total Transparency).

### Thesis 2 — Minimal core, infinite extension

> "It comes with four tools. That's all it has — read, write, edit, bash. Don't read the text, just look at the size."

The base harness ships the smallest possible system prompt, the smallest possible tool set, and the smallest possible feature set. Models are already RL-trained as coding agents; they don't need 10,000 tokens of instruction telling them they are. Every capability beyond the minimal core is an extension, opt-in per session or per operator.

Aligns with PRINCIPLES.md §1 (Modular & Composable), §8 (Progressive Disclosure).

### Thesis 3 — Self-modifying & malleable

> "How do you build a Pi extension? You don't. You tell Pi to build it for you based on your specifications."

The agent can extend itself. It does so by reading documentation and examples that ship with the harness, writing a new extension as a TypeScript module, and hot-reloading it within the same session. The operator's role is intent and approval; the agent's role is implementation.

Aligns with PRINCIPLES.md §4 (Dynamic Runtime Configuration), §9 (Reliability Through Code, Power Through LLMs).

### Thesis 4 — Hot reload as the iteration unit

> "And all of that hot reloads. So if you develop an extension for Pi, you do so in the session. And you hot reload the changes and see the effects of that immediately. In game development, you want very low iteration speeds, and that's great."

Restart-to-apply is a defect. The iteration loop between operator intent and observed behaviour MUST be sub-second for everything that can be hot-reloaded: tools, slash commands, event handlers, providers, compaction logic, UI surfaces.

Aligns with PRINCIPLES.md §4.

### Thesis 5 — Package managers, not marketplaces

> "We don't need to reinvent another bunch of silos called Marketplaces. We already have package managers."

Extensions are distributed via NPM. No proprietary store, no review queue, no curation gate. Discoverability is a search layer on top of the package registry, not a separate ecosystem.

Aligns with PRINCIPLES.md §1.

### Thesis 6 — YOLO by default, real security by extension

> "Pi is YOLO by default because my security needs are different than yours, and I don't think a little dialog that pops up every time you call bash, asking you to approve, is a smart security mechanism. So instead, I give you so much rope that you can build anything that's fit for your specific security needs."

Per-call approval prompts are security theatre. The harness exposes the hooks (pre-tool, post-tool, event subscribers) needed to build whatever security model the deployment actually requires — sandboxing, allowlists, audit logs, human-in-the-loop — and refuses to ship a default that pretends to be one.

Aligns with PRINCIPLES.md §1, §9.

### Thesis 7 — Slow down; agents compound errors

> "Agents are actually compounding booboos with serial learning and no bottlenecks and delayed pain. The delayed pain is for you. Humans feel pain. Agents will happily keep shitting into your codebase."

Agents have no bottleneck on contribution rate, no pain signal, and learn complexity from 90% garbage code. The cost of a slop PR is paid by the maintainer, not the producer. Tooling MUST make it cheap to read every line of critical code, cheap to label code as critical or non-critical, and cheap to reject slop. "I don't read the code anymore" is a failure state.

Aligns with PRINCIPLES.md §7, §9.

### Thesis 8 — Sufficiently detailed spec = a program

> "Know what we call a sufficiently detailed spec? It's a program. So if you leave blanks in your spec, the model fills them with the garbage it learned on the internet."

The operator's intent is either fully expressed as machine-checkable artifacts (tests, types, schemas, eval functions) or it is left to the model's default — which is "garbage to mediocre." The harness should make it easy to upgrade prose intent into runnable intent, not to paper over the gap with longer context windows.

Aligns with PRINCIPLES.md §1, §9.

---

## 2. Where Sovereign Already Honours the Doctrine

The PRINCIPLES.md commitments overlap with Pi's doctrine substantially. This is not a coincidence — Sovereign was conceived along the same intuitions, and Pi crystallises several of them with sharper words. The integration is therefore largely **validation** with targeted **additions**, not a re-architecting.

| Pi Thesis | Sovereign Principle | Status |
| --- | --- | --- |
| 1. Context sovereignty | §5 SSoT, §6 File-Driven, §7 Transparency | Aligned in principle; gap in enforcement (§3.1). |
| 2. Minimal core | §1 Modular, §8 Progressive Disclosure | Aligned; minor restraint required (§3.2). |
| 3. Self-modifying | §4 Runtime Config, §9 Reliability/Power split | Aligned in spirit; not yet a first-class workflow (§3.3). |
| 4. Hot reload | §4 Runtime Config | Aligned at config level; not yet a Pi-extension workflow (§3.4). |
| 5. NPM not marketplace | §1 Modular | Aligned by default — Sovereign has never proposed a marketplace. Codify (§3.5). |
| 6. YOLO + extensible security | §1 Modular, §9 Reliability | Partial — Sovereign currently has no first-class policy layer (§3.6). |
| 7. Slow down | §7 Transparency, §10 Mirrored External Streams | Aligned; needs concrete review workflow (§3.7). |
| 8. Spec = program | §9 Reliability through code | Aligned; needs tooling so prose-spec → runnable-spec is a short trip (§3.8). |

---

## 3. Gaps and Required Additions

For each thesis, the concrete delta between Sovereign as currently planned (PRINCIPLES.md + pi-migration-spec.md + un-openclawing-spec.md) and Sovereign as required to honour the doctrine.

### 3.1 Context Sovereignty — enforcement

[pi-migration-spec.md](pi-migration-spec.md) §17 already promises that Pi events flow 1:1 onto Sovereign's event bus, and that `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>`-style envelopes and timestamp prefixes are deleted. That's necessary but not sufficient. The doctrine demands a positive statement of what Sovereign IS allowed to do to the context.

**Requirements (MUST):**

- **R-CS-1.** Every modification Sovereign makes to a session's message list MUST be a typed, persisted event. There MUST NOT be any code path that inserts text into the context without producing a corresponding `context.mutation` bus event with `{ sessionKey, kind, reason, payload, timestamp }`.
- **R-CS-2.** The set of mutation `kind`s MUST be a closed enum reviewed in this spec: `system_prompt_set`, `system_prompt_appended` (skills, AGENTS.md), `compaction_replaced`, `custom_message_inserted` (per pi-migration-spec.md §17.7), `tool_definition_changed`, `model_switched`, `cwd_changed`, `extension_loaded`, `extension_unloaded`. New `kind`s require a spec amendment.
- **R-CS-3.** Sovereign MUST NOT inject "system reminders" — strings appended to the user turn or system turn — without an explicit operator action that produced the injection. Pi's `convertToLlm` hook plus typed custom messages (pi-migration-spec.md §17.7) is the mechanism; freeform string injection is forbidden.
- **R-CS-4.** The thread view MUST surface every `context.mutation` event in the transcript at the position it took effect. Operators MUST be able to (a) read the full text that was injected, (b) see the reason and origin, (c) revert by branching the session (per pi-migration-spec.md §17.3, "tree-structured sessions").
- **R-CS-5.** Pi version pins MUST be exact (no `^` or `~`). Every Pi upgrade MUST be accompanied by a "context delta" report — diff of system prompt, tool definitions, and `convertToLlm` behaviour between versions — committed alongside the package.json change.

**Requirements (MUST NOT):**

- **R-CS-6.** Sovereign MUST NOT add LSP-style "helpful" injections into tool results (the OpenCode anti-pattern from the talk, "every edit asks the LSP for errors and injects them"). If post-edit diagnostics are wanted, they are surfaced as a separate `WorkItem` the agent can choose to read, not as an invisible addition to the edit-tool result.
- **R-CS-7.** Sovereign MUST NOT prune tool output by token-count heuristic (the OpenCode anti-pattern, "tool output is pruned past a minimum threshold"). Long tool outputs are either fully preserved or summarised by an explicit, observable summarisation step (a `WorkItem` of kind `tool_result_summary` with the original preserved on disk and a link).

### 3.2 Minimal Core — sovereign restraint

The temptation under Sovereign is the opposite of the OpenClaw failure mode: not "the gateway does too much," but "Sovereign-native modules each want to register a tool." Left unchecked, the base toolset balloons.

**Requirements (MUST):**

- **R-MC-1.** Pi's default toolset for a new Sovereign session MUST be exactly the four built-ins (`read`, `write`, `edit`, `bash`) plus `spawn_subagent` (per pi-migration-spec.md §9). Adding a fifth built-in tool requires a spec amendment.
- **R-MC-2.** Every other Sovereign capability that the agent should be able to invoke (issues, planning, recordings, voice, terminal, meetings) MUST be registered as a **Pi extension**, not a built-in tool. Extensions are opt-in per session, per thread, or per org via the registry shape defined in §4.
- **R-MC-3.** Sovereign's system prompt addition to Pi's MUST be bounded — limit to be set explicitly, default 500 tokens, exceeded only by skills/AGENTS.md content authored by the operator. Hard ceiling: 2,000 tokens of Sovereign-authored system context per session. Beyond that, capability becomes a tool or extension, not a prompt addition.

**Requirements (SHOULD):**

- **R-MC-4.** Default subagent toolsets SHOULD be more restrictive than parent — `read`, `grep`, `find`, `ls` by default, `bash` and `edit` opt-in per spawn (already partial in pi-migration-spec.md §9 R-SA-11; promoted to the doctrine).

### 3.3 Self-modifying — make it a first-class workflow

pi-migration-spec.md §17.4 documents that Sovereign-native tools can be Pi tools and that Pi accepts custom tool registration. It does not yet describe the **operator workflow** by which an operator says "I need a new capability" and the agent writes an extension to provide it.

**Requirements (MUST):**

- **R-SM-1.** Sovereign MUST ship the Pi extension documentation and code examples (the same payload Mario ships in upstream Pi) inside the binary so that the agent can read them on demand. They MUST be located at a deterministic path under `PI_AGENT_DIR/docs/extensions/` so the bundled examples extension can find them. Bundling is reproducible — `pnpm build` writes them; CI verifies presence.
- **R-SM-2.** A first-party Sovereign extension `sovereign-extension-author` MUST register tools that let the agent: (a) read the extension docs, (b) propose an extension as a new TypeScript file under a per-org `extensions/` directory, (c) hot-load it into the current session, (d) run a smoke test against it, (e) commit it to the org's extension repository if the operator approves.
- **R-SM-3.** Hot-load MUST be per-session by default. Promotion to "default for this thread / org / global" is an explicit operator action recorded as a `context.mutation` event of kind `extension_loaded`.
- **R-SM-4.** An extension's source file MUST be readable in the transcript when it is loaded — file path, content hash, and a link to the file in the file picker. No invisible extension loads.

**Requirements (SHOULD):**

- **R-SM-5.** Each org's extension directory SHOULD be a git repository under the org's project root, versioned and reviewable like any other code. Cross-org extensions live in `~/.sovereign/extensions/` and are versioned via a single repository.

### 3.4 Hot Reload — beyond config to extensions

PRINCIPLES.md §4 commits to hot-reloadable config. Pi's hot-reload covers extensions too. The combination is what gives the iteration-loop property the talk describes.

**Requirements (MUST):**

- **R-HR-1.** When an extension file under a watched directory changes, Sovereign MUST re-evaluate it and apply the change to all sessions that have it loaded. The current LLM turn finishes; the change is in effect for the next turn.
- **R-HR-2.** Hot-reload MUST emit `extension_reloaded` events on the bus with `{ extensionPath, contentHash, affectedSessions, tools, slashCommands }`. The UI surfaces this in any affected thread.
- **R-HR-3.** A failed reload (syntax error, type error, throws on init) MUST NOT crash Sovereign or affected sessions. The previous version stays active; the failure is surfaced as a `WorkItem` of kind `extension_reload_failed` in any subscribed thread.

### 3.5 Package Manager, not Marketplace — codify

Sovereign has never proposed a marketplace. Codify the commitment so it doesn't get added later.

**Requirements (MUST NOT):**

- **R-PM-1.** Sovereign MUST NOT ship a proprietary extension store, review queue, signing authority, curation gate, or "verified" badge. Extension distribution rides on NPM, GitHub, Radicle, or whatever package surface the operator's organisation already uses.

**Requirements (MAY):**

- **R-PM-2.** Sovereign MAY provide a search UI over NPM and other registries that filters for Pi-extension packages by `pi-extension` keyword. This is presentation only; install is a normal `pnpm add`.

### 3.6 YOLO + extensible security — wire the hooks

Pi exposes `beforeToolCall` and `afterToolCall` hooks ([pi-migration-spec.md §17.4](pi-migration-spec.md#174-tool-runtime-improvements)). Sovereign currently has no first-class policy layer using them. The doctrine says: ship the hooks, refuse to ship a default approval dialog, let real security models be extensions.

**Requirements (MUST):**

- **R-YO-1.** Sovereign MUST NOT ship a per-tool-call approval dialog as a default behaviour. The default Pi mode (no `beforeToolCall` policy) is the default Sovereign mode.
- **R-YO-2.** A first-party `sovereign-extension-policy` extension MUST be available and documented. It registers `beforeToolCall` and `afterToolCall` hooks driven by a per-org policy file at `~/.sovereign/orgs/<org>/policy.yaml`. Policy directives are evaluated as data, never as LLM prompts — the policy never asks the model anything.
- **R-YO-3.** The policy extension MUST support: (a) per-tool allowlists/denylists, (b) per-tool argument patterns (regex match on `bash` commands, path match on `read`/`write`/`edit`), (c) audit-only mode (log to bus, never block), (d) interactive mode (block until operator confirms via a typed bus event, with timeout fallback to deny).
- **R-YO-4.** Tool-call audit events MUST be persisted, append-only, per org, in a file-driven log. The log is the source of truth for "what did the agent do in this org?"

**Requirements (MUST NOT):**

- **R-YO-5.** Sovereign MUST NOT route policy decisions through any LLM. The model never decides whether the model is allowed to do something — that decision is made by deterministic code reading deterministic data.

### 3.7 Slow Down — concrete review workflow

The doctrine demands cheap reads of critical code and cheap rejections of slop. Sovereign already mirrors PRs (PRINCIPLES.md §10) and ships a `review` skill. What's missing: a per-file or per-module **criticality label** that drives whether the review pass is "skim" or "read every line."

**Requirements (MUST):**

- **R-SD-1.** Sovereign MUST support a `CODEOWNERS.criticality` file (or comparable convention) per project that labels paths as `critical | standard | yolo`. Default for unlabelled code is `standard`.
- **R-SD-2.** The review surface MUST show the criticality label inline on every changed file. For `critical` paths, the line-level review pane MUST be the default view; for `yolo` paths the file is marked auto-approved if CI passes.
- **R-SD-3.** Agent-generated PRs MUST tag every changed file with the criticality of that file at HEAD. If an agent edits a `critical` file, the PR MUST surface a "human-must-read" marker that blocks auto-merge regardless of other checks.
- **R-SD-4.** The agent MUST be told, in the tool definitions or system prompt for the edit and write tools, that paths in `critical` may not be auto-modified — they require a `human_approval_requested` response that surfaces the proposed diff to the operator.

**Requirements (SHOULD):**

- **R-SD-5.** A "booboo budget" telemetry SHOULD be surfaced per thread: count of agent edits, count of unreviewed edits, ratio of automated tests added per edit, and an "abstraction growth" signal (new exports, new files, new abstract types). Designed for operator awareness, not enforcement.
- **R-SD-6.** Sovereign SHOULD ship the auto-close-and-vouch pattern from the talk for incoming issues and PRs on Sovereign's own repository: an unsolicited LLM-authored PR is auto-closed with a request for a human-voice issue first; vouched accounts skip the gate. Implemented as a Sovereign extension that runs against the issues/PR mirror.

### 3.8 Spec = Program — upgrade-prose-to-runnable workflow

This is the deepest doctrine and the slowest to land. The handle Sovereign already has: planning DAGs as first-class entities. The handle it needs: every plan node should be able to grow types, tests, and an eval function inline, and the agent should be wired to operate on the runnable form.

**Requirements (MUST):**

- **R-SP-1.** A planning node MUST be able to attach: (a) acceptance criteria as prose, (b) types/schemas as TypeScript, (c) a test or eval function as TypeScript, (d) the implementation. Each is a separate, named, optionally-empty field with a deterministic file location.
- **R-SP-2.** The agent MUST be able to enumerate which planning nodes are "spec-only" (only prose acceptance criteria) vs "spec-runnable" (have at least types or tests) and prefer working on spec-runnable nodes. A tool `list_runnable_plans` is sufficient.
- **R-SP-3.** When an operator asks the agent to work on a spec-only node, the agent's default response MUST be to propose elevating the prose to a runnable form (suggest schemas, suggest a test) before writing implementation. The operator can override per session.

**Requirements (SHOULD):**

- **R-SP-4.** Plan nodes SHOULD show a "spec maturity" indicator in the planning view (prose | types | tests | implementation | tested-in-prod), driven by file presence.

---

## 4. Concrete Spec Amendments

These are changes to existing specs that this doctrine requires. They MUST be folded into their respective specs before the corresponding implementation phase ships.

### 4.1 `pi-migration-spec.md`

| Section | Amendment |
| --- | --- |
| §2 Design Philosophy | Add a bullet: "Pi's doctrine governs Sovereign's adoption — see [pi-principles-spec.md](pi-principles-spec.md). Where this migration spec and the principles spec disagree, the principles spec wins." |
| §3 Pi Surface Recap | Note that the table omits Pi's extension surface (`AgentExtension`, hot-reload watchers, `ResourceLoader`). Add a row pointing to §17.4 and to pi-principles-spec.md §3.3–3.4. |
| §5 Module Layout | Add `extensions/` directory layout per pi-principles-spec.md §3.3 (R-SM-2). |
| §7 New AgentBackend Methods | Add `loadExtension(sessionKey, path)`, `unloadExtension(sessionKey, extensionId)`, `listExtensions(sessionKey)`. These are the bus-visible surface for R-SM-3 and R-CS-1. |
| §12 Configuration | Add `PI_EXTENSIONS_DIR` (default `~/.sovereign/extensions`), `PI_ORG_EXTENSIONS_DIR` (per-org override). |
| §15 Verification Checklist | Add: (a) agent can read extension docs via a built-in tool, (b) agent can propose and hot-load an extension in a session, (c) `context.mutation` events fire for every system-prompt/tool-definition change, (d) attempting to insert a system reminder without a typed event fails CI. |
| §16 Resolved Design Decisions | Add decision: "Skills (markdown files) are honoured via Pi's existing skill loader. Skill content goes into the system prompt and counts toward the 2,000-token Sovereign system-context ceiling (R-MC-3)." |
| §17.4 (or new §17.12) | Add a subsection cross-referencing pi-principles-spec.md §3.6 — policy hooks are the security model, not approval dialogs. |

### 4.2 `un-openclawing-spec.md`

| Section | Amendment |
| --- | --- |
| §2 Goals | Add: "The seam MUST allow per-backend declaration of which Pi doctrine theses are honoured (e.g., Claude Code adapter cannot honour Thesis 1 in full because Claude Code controls system prompt; this is documented as a known divergence, not silently accepted)." |
| §5 The Seam | Add to `AgentBackend`: `getDoctrineCompliance(): DoctrineCompliance` returning which theses the backend can/cannot honour. The UI surfaces this per-thread. |

### 4.3 `claude-code-adapter-spec.md`

| Section | Amendment |
| --- | --- |
| (new §) Doctrine divergences | Claude Code violates Thesis 1 (system prompt changes per release, context invisibly mutated), Thesis 2 (large built-in toolset), Thesis 6 (per-tool approval), and Thesis 4 (no extension hot-reload). The adapter MUST surface a banner on threads using Claude Code that names these divergences. Operators choose Claude Code with informed consent. |

### 4.4 `PRINCIPLES.md`

No edits. PRINCIPLES.md is foundational; this spec sits downstream. Optionally add a single line at the end: "Pi's doctrine — see [plans/pi-principles-spec.md](plans/pi-principles-spec.md) — operationalises these principles for the agent runtime layer." Decide separately whether to land that pointer.

### 4.5 `README.md`

Add a "Why Pi" paragraph in the architecture section that articulates the four most operator-facing theses (1, 2, 6, 7) and links to this spec.

---

## 5. Phasing

These amendments are phased against the existing pi-migration-spec.md phases, not as a separate track. Pi-as-doctrine and Pi-as-library land together.

**Concurrent with pi-migration-spec.md Phase A:**

- R-CS-1, R-CS-2 (typed `context.mutation` events) — implemented in the backend translator.
- R-MC-1, R-MC-3 (toolset and system-prompt ceiling) — enforced by Sovereign's Pi initialisation.
- R-PM-1 (no marketplace) — codified in README, no code.

**Concurrent with pi-migration-spec.md Phase B (subagents):**

- R-MC-4 (subagent toolset restriction) — already aligned with pi-migration-spec.md §9 R-SA-11.

**New phase F — Extension authoring as a workflow:**

- R-SM-1 through R-SM-5 (extension docs ship, `sovereign-extension-author` extension, hot-load, smoke test, commit-to-org-repo).
- R-HR-1 through R-HR-3 (hot-reload semantics + events + failure handling).
- Ships after Phase D (default flip) so the workflow is built on a stable foundation.

**New phase G — Policy and review:**

- R-YO-1 through R-YO-5 (policy extension, audit log).
- R-SD-1 through R-SD-6 (criticality labels, review surface, agent-aware critical-path protection, booboo telemetry, auto-close pattern for the Sovereign repo).
- Ships after Phase F. The two halves of the doctrine that govern what code gets written and how it gets reviewed.

**New phase H — Spec → program:**

- R-SP-1 through R-SP-4 (planning-node attachments, `list_runnable_plans`, prose-to-runnable workflow).
- Ships against the existing planning module work; not blocked on Pi.

**Out of order:** R-CS-5 (Pi version pin and context-delta report) MUST land before the first Pi version bump after migration, regardless of phase.

---

## 6. Open Questions

These are real open questions, not theoretical ones. Each requires an operator decision before the relevant phase can ship.

1. **Skills as system-prompt content.** Pi treats skills (markdown files) as system-prompt additions. Under R-MC-3 the operator's skills count against the 2,000-token ceiling. Is that the right boundary, or should skills be exempt because they're operator-authored? Default position: count them, raise the ceiling when concrete pressure exists.
2. **Extension trust scope.** When the agent writes and hot-loads an extension during a session, does the extension run with the same trust as built-in tools (R-SM-3 implies yes), or does it go through `beforeToolCall` policy like everything else (R-YO-2 implies yes)? They are not in conflict but the layering needs an explicit decision: extensions run **inside** the policy layer, same as any tool.
3. **Criticality default.** R-SD-1 defaults unlabelled code to `standard`. For Sovereign itself, which is being written largely by agents, should the default be `critical` until proven otherwise? Default position: yes for Sovereign's own repos; `standard` everywhere else.
4. **Booboo telemetry surfacing.** R-SD-5 says "designed for operator awareness, not enforcement." But thresholds that trigger a soft warning ("this thread has added 200 lines of unreviewed code today") may be worth shipping. Decide after the telemetry exists and has been observed for a week.
5. **Closed-doctrine backends.** When a backend (e.g., Claude Code adapter) cannot honour Thesis 1 in full, do we ship the adapter at all? Default position: yes, with the divergence banner from §4.3, because the operator chooses; refusing to ship the adapter is paternalism, but using it without informed consent is the failure mode the doctrine names.

---

## 7. Non-Goals

- This spec does not specify Sovereign's UI. The principles drive what surfaces are needed (context-mutation log, policy-audit log, extension-loaded banner, criticality labels in review) but the visual design is a separate concern.
- This spec does not specify a sandbox for extensions. Hot-loaded TypeScript runs in-process by Pi's design. Sandboxing is a deployment concern, addressable via Pi's `beforeToolCall` policy hooks; not in this spec.
- This spec does not specify how operator-authored extensions are licensed when published to NPM. Licensing is per-org policy.
- This spec does not regulate which providers Sovereign supports. Pi already abstracts providers (pi-migration-spec.md §17.5); the doctrine has no opinion beyond "model choice exists."

---

## 8. References

- [Building Pi in a World of Slop — Mario Zechner](references/pi-mario-zechner-talk-2025.md) — primary source, transcript and metadata.
- [PRINCIPLES.md](../PRINCIPLES.md) — Sovereign's architectural principles.
- [pi-migration-spec.md](pi-migration-spec.md) — mechanical migration from OpenClaw to Pi.
- [un-openclawing-spec.md](archive/un-openclawing-spec.md) — the `AgentBackend` seam.
- [Pi documentation](https://github.com/earendil-works/pi) — upstream Pi SDK, extension API, RPC interface.
