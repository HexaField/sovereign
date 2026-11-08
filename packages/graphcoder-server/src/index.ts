// @sovereign/graphcoder-server: Graphcoder's service and HTTP routes. A host
// (Sovereign's bootstrap, or a standalone server) supplies the ports and mounts
// the router.

export {
  createGraphcoderService,
  UnknownRepoError,
  type GraphcoderOptions,
  type GraphcoderPorts,
  type GraphcoderService,
  type GraphcoderStatus,
  type RepoStats
} from './service.js'
export { createGraphcoderRouter } from './routes.js'
export { codegraphCommand, hasCodegraphIndex, indexPath, openCodegraphIndex } from './codegraph.js'
export { createCodegraphIndexer, type CodegraphIndexerOptions, type Indexer } from './indexer.js'
export { createStructureStore, STRUCTURE_VERSION, type CachedStructure, type StructureStore } from './structure.js'
export {
  CONCEPTS_VERSION,
  createConceptStore,
  UnknownRefError,
  type ConceptStore,
  type ConceptStoreOptions
} from './concepts.js'
export { createSerialQueue, type SerialQueue } from './queue.js'
export { readSide, takeSnapshot } from './side.js'
export { parseTestCases, readTestFiles } from './test-files.js'
export { createNodeRepoFiles } from './repo-files.js'
