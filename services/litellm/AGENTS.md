# LiteLLM proxy (local inference routing)

`services/litellm/` contains the LiteLLM proxy that routes non-Claude model sessions to local inference backends.

## How it works

Sovereign's claude-code backend detects non-Claude models via `familyForModel()`. When a session uses an unrecognised model (e.g. `qwen3.8-27b`), it sets `ANTHROPIC_BASE_URL=http://localhost:4000` and `ANTHROPIC_API_KEY=litellm` in the Claude Code CLI subprocess env. The Claude Code CLI then sends all Anthropic SDK calls to LiteLLM at `:4000` instead of `api.anthropic.com`. Claude sessions bypass the proxy entirely.

## Session handling for LiteLLM threads

Non-Claude threads always start a **fresh session** (`--session-id`) regardless of existing JSONL files. The SDK ignores `env` when resuming a subprocess — a fresh subprocess is required to pick up the `ANTHROPIC_BASE_URL` env injection. History is preserved via the shared history-log system.

`effort` (extended thinking budget) is set to `undefined` for non-Claude sessions — local models do not accept Anthropic thinking parameters.

## LiteLLM config (`services/litellm/litellm.yaml`)

Critical settings:

- `use_chat_completions_url_for_anthropic_messages: true` — forces chat/completions routing for all providers including `openai/*`. Without this, LiteLLM routes `openai/*` models (like `openai/qwen3.8-27b`) through the Responses API, which translates `thinking.budget_tokens` → `reasoning_effort: "high"`. llama-server's Jinja template only accepts `xhigh`/`medium`/`low` → 500 error.
- `drop_params: true` — drops unsupported Anthropic-specific params cleanly.
- `model_info.supports_extended_thinking: false` — signals the model does not support extended thinking.

## Service setup (on the Sovereign host)

```bash
# Start the proxy
systemctl --user start litellm
# or manually:
litellm --config services/litellm/litellm.yaml --port 4000 --host 127.0.0.1

# Verify routing
curl -s -X POST http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: litellm" \
  -d '{"model":"qwen3.8-27b","max_tokens":50,"messages":[{"role":"user","content":"Say: LITELLM_WORKS"}]}'
```

## Known gotcha — mid-turn system message injection (patched in LiteLLM)

**Symptom:** `POST /v1/messages?beta=true` → 500 "Jinja Exception: System message must be at the beginning." on every request from a qwen/LiteLLM session.

**Root cause:** Claude Code CLI injects MCP Server Instructions as a `{"role": "system"}` entry within the Anthropic `messages` array on every API call (not just the first). LiteLLM's `translate_anthropic_messages_to_openai` appended this at its original position via `_translate_midturn_system_message_to_openai`. After `_add_system_message_to_messages` placed the main system prompt at position 0, the resulting OpenAI-format message array had structure `[system, user, system]`. llama-server's Jinja template rejects any system message after position 0.

**Fix — LiteLLM patch (applied to installed package):**

File: `$UV_TOOLS_DIR/litellm/lib/python3.12/site-packages/litellm/llms/anthropic/experimental_pass_through/adapters/transformation.py`

In `translate_anthropic_to_openai`, after the call to `_add_system_message_to_messages` (around line 1090), insert:

```python
## CONSOLIDATE SYSTEM MESSAGES
# Some SDK clients (e.g. Claude Code CLI) inject mid-turn system messages
# within the messages array (e.g. MCP server instructions, system-reminders).
# OpenAI-compat backends that use Jinja chat templates (llama-server) require
# ALL system content to appear in a single message at position 0 — a system
# message at any later index raises "System message must be at the beginning."
# Fix: collect all system messages, merge their content into the leading system
# entry, and remove the duplicates from the sequence.
system_msgs = [m for m in new_messages if isinstance(m, dict) and m.get("role") == "system"]
if len(system_msgs) > 1:
    non_system_msgs = [m for m in new_messages if not (isinstance(m, dict) and m.get("role") == "system")]
    merged_content: list = []
    for sm in system_msgs:
        content = sm.get("content", "")
        if isinstance(content, str):
            merged_content.append({"type": "text", "text": content})
        elif isinstance(content, list):
            merged_content.extend(content)
    new_messages = [{"role": "system", "content": merged_content}] + non_system_msgs
```

**⚠️ Upgrade warning:** Running `uv tool upgrade litellm` overwrites the patch. Re-apply after every upgrade:

```bash
python3 services/litellm/patch-litellm.py          # apply (idempotent)
python3 services/litellm/patch-litellm.py --check  # verify
systemctl --user restart litellm
```

The fix lives on the fork at [HexaField/litellm — fix/consolidate-mid-turn-system-messages](https://github.com/HexaField/litellm/tree/fix/consolidate-mid-turn-system-messages). The patch script (`services/litellm/patch-litellm.py`) applies the same fix idempotently to the installed package regardless of version.
