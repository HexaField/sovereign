import { defineConfig } from 'tsdown'
import base from '../../tsdown.config.ts'

// The service and router, and the index reader on its own so the CLI can load it without express.
export default defineConfig({ ...base, entry: ['src/index.ts', 'src/codegraph.ts'] })
