import { defineConfig } from 'tsdown'
import base from '../../tsdown.config.ts'

// Two entries: the library, and the MCP server Sovereign launches per session.
export default defineConfig({ ...base, entry: ['src/index.ts', 'src/mcp.ts'] })
