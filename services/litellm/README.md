# LiteLLM Proxy Service

Routes Sovereign's `claude-code` backend sessions to multiple inference backends via a single Anthropic Messages API proxy.

## Architecture

```
Sovereign claude-code SDK subprocess
  │  (ANTHROPIC_BASE_URL=http://localhost:4000)
  │  (ANTHROPIC_API_KEY=litellm)
  ▼
LiteLLM proxy (:4000)  ←→  litellm.yaml routing rules
  │
  ├── claude-* models  →  Anthropic API (api.anthropic.com) using real key
  │
  └── qwen* models     →  llama-server (:9090, OpenAI compat)
```

## Configuration

`SOVEREIGN_LITELLM_URL=http://localhost:4000` in Sovereign's environment enables the proxy path. When set:

- Sovereign injects `ANTHROPIC_BASE_URL=http://localhost:4000` into every SDK subprocess
- Sovereign injects `ANTHROPIC_API_KEY=litellm` (the LiteLLM master key) — this replaces the real Anthropic key, which must live in LiteLLM's env instead

Model routing uses the model name sent by the SDK. Add new local models to `litellm.yaml` under `model_list`.

## Setup

```bash
# Install litellm
pip install litellm
# or:
uv tool install litellm

# Configure
cd services/litellm && bash setup.sh
# Edit ~/.config/litellm/env with the real ANTHROPIC_API_KEY

# Start
systemctl --user enable --now litellm

# Verify
curl http://localhost:4000/v1/models | jq '.data[].id'
```

## Sovereign config

In `~/.sovereign/data/config.json` or via systemd EnvironmentFile for Sovereign:

```json
"agentBackend": {
  "claudeCode": {
    "litellm": {
      "url": "http://localhost:4000",
      "apiKey": "litellm"
    }
  }
}
```

Or set the env var (overrides config store):

```
SOVEREIGN_LITELLM_URL=http://localhost:4000
```

## Adding local models

1. Ensure the model is running in llama-server:  
   `curl http://localhost:9090/v1/models` to verify
2. Add an entry to `litellm.yaml` under `model_list`:
   ```yaml
   - model_name: 'my-model-name'
     litellm_params:
       model: 'openai/my-model-name'
       api_base: 'http://localhost:9090/v1'
       api_key: 'unused'
   ```
3. Restart litellm: `systemctl --user restart litellm`
4. Set the model in a Sovereign thread

## Wind tunnel testing

```bash
cd wind-tunnel
./run.sh --litellm --scenario s32
```

s32 self-skips in standard runs. `--litellm` overlays `docker-compose.litellm.yml` which points Sovereign at mock-llm as a proxy stand-in, activating the env injection path without requiring a real LiteLLM instance.
