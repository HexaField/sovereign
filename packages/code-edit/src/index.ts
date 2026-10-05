// Edit code by symbol name. `editFile` works on a file on disk, `editFiles`
// on several at once (all or nothing); `applyOps`
// is the pure core it runs on (text in, text out). The MCP server entry is
// `./mcp` (dist/mcp.js).

export * from './types.js'
export { applyOps, type ApplyOptions, type EditOutcome, type SignatureChange } from './apply.js'
export { createAnalyzer } from './analyzer.js'
export { editFile, editFiles, type EditFileOptions, type EditFileResult, type EditFilesResult } from './edit-file.js'
export { resolveSymbol } from './resolve.js'
export { unifiedDiff } from './unified-diff.js'
