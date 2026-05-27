// Environment variable override resolution.
//
// `SOVEREIGN_<A>__<B>__<C>=value` overrides config path `a.b.c`. We require
// at least one `__` in the suffix — single-segment vars like `SOVEREIGN_TLS`
// or `SOVEREIGN_DATA_DIR` are bootstrap/legacy and intentionally ignored here
// (they would otherwise create unknown top-level keys and fail strict schema
// validation). This is the undocumented debugging affordance per
// config-consolidation-spec §7.

export function resolveEnvOverrides(): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const prefix = 'SOVEREIGN_'

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || value === undefined) continue
    const rest = key.slice(prefix.length)
    if (!rest.includes('__')) continue // bootstrap/legacy single-segment vars are ignored
    const path = rest.toLowerCase().split('__')

    let coerced: unknown = value
    if (/^\d+$/.test(value)) coerced = Number(value)
    else if (value === 'true') coerced = true
    else if (value === 'false') coerced = false

    let obj = result
    for (let i = 0; i < path.length - 1; i++) {
      if (!(path[i] in obj)) obj[path[i]] = {}
      obj = obj[path[i]] as Record<string, unknown>
    }
    obj[path[path.length - 1]] = coerced
  }

  return result
}
