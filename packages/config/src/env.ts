// Environment variable override resolution

export function resolveEnvOverrides(): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const prefix = 'SOVEREIGN_'

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || value === undefined) continue
    const path = key.slice(prefix.length).toLowerCase().split('__')

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
