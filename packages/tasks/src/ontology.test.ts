import { describe, it, expect } from 'vitest'
import { FORGE_SHACL_CLASSES } from './ontology.js'

// The AD4M executor refuses a subject class whose property reuses a synthetic
// instance field.
const SYNTHETIC = ['id', 'baseExpression', 'createdAt', 'updatedAt', 'author', 'timestamp', '__links']

describe('FORGE_SHACL_CLASSES', () => {
  it('names no property after a synthetic instance field', () => {
    for (const [cls, shape] of Object.entries(FORGE_SHACL_CLASSES)) {
      const names = (shape as { properties: { name: string }[] }).properties.map((p) => p.name)
      expect(
        names.filter((n) => SYNTHETIC.includes(n)),
        cls
      ).toEqual([])
    }
  })
})
