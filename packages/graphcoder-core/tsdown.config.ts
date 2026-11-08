import { defineConfig } from 'tsdown'
import base from '../../tsdown.config.ts'

// The main entry, the contract types other Sovereign packages may import, and
// the import scanner the boundary tests share.
export default defineConfig({ ...base, entry: ['src/index.ts', 'src/contract.ts', 'src/boundary.ts'] })
