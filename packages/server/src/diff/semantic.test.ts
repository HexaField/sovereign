import { describe, it } from 'vitest'

describe('diffSemantic', () => {
  describe('JSON', () => {
    it.todo('detects added keys')
    it.todo('detects removed keys')
    it.todo('detects changed values')
    it.todo('uses JSON path notation for nested keys')
    it.todo('handles nested object changes')
    it.todo('handles array changes')
  })

  describe('YAML', () => {
    it.todo('detects added keys in YAML')
    it.todo('detects removed keys in YAML')
    it.todo('detects changed values in YAML')
    it.todo('uses path notation for nested YAML keys')
  })

  describe('TOML', () => {
    it.todo('detects added keys in TOML')
    it.todo('detects removed keys in TOML')
    it.todo('detects changed values in TOML')
  })

  describe('package.json special handling', () => {
    it.todo('shows old → new version for dependency version changes')
    it.todo('detects added dependencies')
    it.todo('detects removed dependencies')
  })

  describe('fallback', () => {
    it.todo('falls back to text diff when JSON parse fails')
    it.todo('falls back to text diff when YAML parse fails')
    it.todo('falls back to text diff when TOML parse fails')
    it.todo('sets fallbackTextDiff on SemanticDiff when falling back')
  })

  describe('format detection', () => {
    it.todo('sets format field to "json" for JSON diffs')
    it.todo('sets format field to "yaml" for YAML diffs')
    it.todo('sets format field to "toml" for TOML diffs')
  })
})
