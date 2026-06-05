// HTTP forwarder. Every MCP tool call becomes one POST to Sovereign.
//
// Failure modes the sidecar tolerates gracefully:
//   - Sovereign is down → tools/list still works (catalog is local). Tool
//     calls return `is_error: true` with the network error in `content`.
//     The MCP server stays connected; the SDK's catalog is not lost.
//   - Sovereign returns 401 → bad shared secret. The error surface mirrors a
//     500 with the body text.

export interface ForwarderConfig {
  /** Base URL for the Sovereign daemon, no trailing slash. Default localhost:5801. */
  sovereignUrl: string
  /** If set, sent as `X-Sovereign-Mcp-Secret` to match the daemon's check. */
  sharedSecret?: string
  /** Hard timeout per call. Default 30 s — browser ops can be slow. */
  timeoutMs?: number
}

export type ForwardFn = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<{
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}>

export function createForwarder(cfg: ForwarderConfig): ForwardFn {
  const timeoutMs = cfg.timeoutMs ?? 30_000
  return async (toolName, args) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('sovereign-mcp: timeout')), timeoutMs)
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (cfg.sharedSecret) headers['x-sovereign-mcp-secret'] = cfg.sharedSecret
      const res = await fetch(`${cfg.sovereignUrl}/api/mcp-rpc/${encodeURIComponent(toolName)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
        signal: controller.signal
      })
      const body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as
        | {
            ok: true
            content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
          }
        | { ok: false; error: string }
      if (!body.ok) {
        return {
          content: [{ type: 'text' as const, text: `sovereign-mcp error: ${body.error}` }],
          isError: true
        }
      }
      return { content: body.content }
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `sovereign-mcp forward failed: ${err?.message ?? String(err)}` }],
        isError: true
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
