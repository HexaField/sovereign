/**
 * Fetches the health status from the API.
 * Uses a relative URL — the Vite dev server proxies /health and /api to the
 * Sovereign server. In production the client is served by the same origin
 * (Sovereign itself), so relative paths just work.
 * @returns A promise that resolves to the health status message and status.
 */
export const fetchHealth = async () => {
  const res = await fetch('/health')
  if (!res.ok) {
    throw new Error('Network response was not ok')
  }
  return res.json() as Promise<{ message: string; status: string }>
}
