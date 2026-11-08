import { defineConfig } from 'tsdown'
import base from '../../tsdown.config.ts'

// The `graphcoder` binary, and the command runner it wraps (what the tests call).
export default defineConfig({ ...base, entry: ['src/index.ts', 'src/cli.ts'] })
