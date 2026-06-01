// Core config store

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { EventBus, ModuleStatus } from '@sovereign/core'
import type { ConfigStore, SovereignConfig, ConfigChange } from './types.js'
import { defaults } from './defaults.js'
import { schema, validate } from './schema.js'
import { resolveEnvOverrides } from './env.js'
import { createHistory } from './history.js'
import { createSecretsStore, SECRET_MASK } from './secrets.js'

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>)
    } else {
      result[key] = source[key]
    }
  }
  return result
}

function getByPath(obj: unknown, dotPath: string): unknown {
  const parts = dotPath.split('.')
  let current: unknown = obj
  for (const p of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[p]
  }
  return current
}

function setByPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {}
    }
    current = current[parts[i]] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

function diffPaths(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  prefix = ''
): Array<{ path: string; oldValue: unknown; newValue: unknown }> {
  const changes: Array<{ path: string; oldValue: unknown; newValue: unknown }> = []
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)])
  for (const key of allKeys) {
    const fullPath = prefix ? `${prefix}.${key}` : key
    const oldVal = oldObj[key]
    const newVal = newObj[key]
    if (
      oldVal &&
      typeof oldVal === 'object' &&
      !Array.isArray(oldVal) &&
      newVal &&
      typeof newVal === 'object' &&
      !Array.isArray(newVal)
    ) {
      changes.push(...diffPaths(oldVal as Record<string, unknown>, newVal as Record<string, unknown>, fullPath))
    } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({ path: fullPath, oldValue: oldVal, newValue: newVal })
    }
  }
  return changes
}

/** Per resolved decision in config-consolidation-spec §7: one config profile per configDir. */
function rejectProfileSiblings(configDir: string): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(configDir)
  } catch {
    return
  }
  const siblings = entries.filter((f) => /^config\.[^.]+\.json$/.test(f) && f !== 'config.json')
  if (siblings.length > 0) {
    throw new Error(
      `[config] refusing to start: found ${siblings.length} profile sibling(s) in ${configDir}: ` +
        `${siblings.join(', ')}. One config profile per config dir is enforced — ` +
        `use a different SOVEREIGN_CONFIG_DIR for each environment instead. ` +
        `See plans/config-consolidation-spec.md §7.`
    )
  }
}

/**
 * `configDir` holds user-edited state (`config.json`) — version-controlled.
 * `dataDir`   holds runtime state (`secrets.json`, `config-history.jsonl`) —
 *             gitignored. Defaults to `configDir` for tests that don't care.
 */
export function createConfigStore(bus: EventBus, configDir: string, dataDir: string = configDir): ConfigStore {
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  rejectProfileSiblings(configDir)

  const configPath = path.join(configDir, 'config.json')
  const history = createHistory(dataDir)
  const secrets = createSecretsStore(dataDir)
  const changeHandlers = new Map<string, Set<(change: ConfigChange) => void>>()

  // Load file config
  let fileConfig: Record<string, unknown> = {}
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    } catch {
      fileConfig = {}
    }
  }

  // Merge: defaults + file + env (env layered last; never written to disk)
  const envOverrides = resolveEnvOverrides()
  let config = deepMerge(
    deepMerge(deepClone(defaults) as unknown as Record<string, unknown>, fileConfig),
    envOverrides
  ) as unknown as SovereignConfig

  // Validate on startup
  const startupValidation = validate(config)
  if (!startupValidation.valid) {
    console.warn('[config] startup validation failed, falling back to defaults:', startupValidation.errors.join('; '))
    config = deepClone(defaults)
  }

  // Write initial config if file doesn't exist
  if (!fs.existsSync(configPath)) {
    writeConfig(fileConfig as Record<string, unknown>)
  }

  function writeConfig(data: Record<string, unknown>) {
    fs.mkdirSync(configDir, { recursive: true })
    const tmpPath = configPath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2))
    fs.renameSync(tmpPath, configPath)
  }

  function getFileConfig(): Record<string, unknown> {
    if (fs.existsSync(configPath)) {
      try {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      } catch {
        return {}
      }
    }
    return {}
  }

  function rebuildConfig(newFileConfig: Record<string, unknown>): SovereignConfig {
    return deepMerge(
      deepMerge(deepClone(defaults) as unknown as Record<string, unknown>, newFileConfig),
      envOverrides
    ) as unknown as SovereignConfig
  }

  function emitChange(change: ConfigChange) {
    bus.emit({ type: 'config.changed', timestamp: change.timestamp, source: 'config', payload: change })
    history.append(change)
    // Fire onChange handlers
    for (const [pattern, handlers] of changeHandlers) {
      if (change.path === pattern || change.path.startsWith(pattern + '.')) {
        for (const h of handlers) h(change)
      }
    }
  }

  const store: ConfigStore = {
    get<T = unknown>(dotPath?: string): T {
      if (!dotPath) return deepClone(config) as T
      return deepClone(getByPath(config, dotPath)) as T
    },

    getPublic() {
      return {
        identity: deepClone(config.identity),
        models: deepClone(config.models)
      }
    },

    set(dotPath: string, value: unknown) {
      const currentFileConfig = getFileConfig()
      const oldValue = getByPath(config, dotPath)
      const newFileConfig = deepClone(currentFileConfig)
      setByPath(newFileConfig, dotPath, value)

      const merged = rebuildConfig(newFileConfig)
      const { valid, errors } = validate(merged)
      if (!valid) throw new Error(`Invalid config: ${errors.join(', ')}`)

      writeConfig(newFileConfig)
      config = merged

      const change: ConfigChange = {
        timestamp: new Date().toISOString(),
        path: dotPath,
        oldValue,
        newValue: value,
        source: 'api'
      }
      emitChange(change)
    },

    patch(partial: Record<string, unknown>) {
      const currentFileConfig = getFileConfig()
      const oldConfig = deepClone(config) as unknown as Record<string, unknown>
      const newFileConfig = deepMerge(deepClone(currentFileConfig), partial)

      const merged = rebuildConfig(newFileConfig)
      const { valid, errors } = validate(merged)
      if (!valid) throw new Error(`Invalid config: ${errors.join(', ')}`)

      writeConfig(newFileConfig)
      config = merged

      const changes = diffPaths(oldConfig, merged as unknown as Record<string, unknown>)
      for (const c of changes) {
        emitChange({
          timestamp: new Date().toISOString(),
          path: c.path,
          oldValue: c.oldValue,
          newValue: c.newValue,
          source: 'api'
        })
      }
    },

    getSchema() {
      return deepClone(schema)
    },

    getHistory(opts) {
      return history.list(opts)
    },

    exportConfig(): SovereignConfig {
      return deepClone(config)
    },

    importConfig(incoming: unknown) {
      const { valid, errors } = validate(incoming)
      if (!valid) throw new Error(`Invalid config: ${errors.join(', ')}`)

      const oldConfig = deepClone(config) as unknown as Record<string, unknown>
      const incomingObj = incoming as Record<string, unknown>
      writeConfig(incomingObj)
      config = rebuildConfig(incomingObj)

      const changes = diffPaths(oldConfig, config as unknown as Record<string, unknown>)
      for (const c of changes) {
        emitChange({
          timestamp: new Date().toISOString(),
          path: c.path,
          oldValue: c.oldValue,
          newValue: c.newValue,
          source: 'api'
        })
      }
    },

    onChange(pathPattern: string, handler: (change: ConfigChange) => void): () => void {
      if (!changeHandlers.has(pathPattern)) changeHandlers.set(pathPattern, new Set())
      changeHandlers.get(pathPattern)!.add(handler)
      return () => {
        changeHandlers.get(pathPattern)?.delete(handler)
      }
    },

    getSecret(key: string): string {
      return secrets.get(key)
    },

    setSecret(key: string, value: string): void {
      const had = secrets.has(key)
      secrets.set(key, value)
      // History records the fact, not the value (per spec §5).
      emitChange({
        timestamp: new Date().toISOString(),
        path: `secrets.${key}`,
        oldValue: had ? SECRET_MASK : undefined,
        newValue: value === '' ? undefined : SECRET_MASK,
        source: 'api'
      })
    },

    status(): ModuleStatus {
      return { name: 'config', status: 'ok' }
    }
  }

  return store
}
