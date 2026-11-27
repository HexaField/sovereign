# POST /api/threads model field (7314d20)

`POST /api/threads` previously ignored the `model` field in the request body. Any thread created with an explicit model (e.g. `model: "qwen3.8-27b"`) silently fell through to `DEFAULT_MODEL_FALLBACK` ("claude-opus-4-6"), making LiteLLM routing untestable via the REST API.

**Fix:** Three-part change in `packages/threads/src/`:

- `threads.ts create()` — added `model?: string` to opts and included it in the constructed `ThreadInfo`.
- `threads.ts projectToV2()` — added `model` to the schema-load whitelist so the field survives a restart.
- `routes.ts POST /api/threads` — extracts `model` from `req.body`, normalises it (strips a `provider/` prefix if present), passes the bare id to `threadManager.create()` and to `createSession()` as `{ provider: 'anthropic', model: bareId }`.

The `PATCH /api/threads/:key/model` route and `update()` were already correct — only `create()` and the POST route needed fixing.
