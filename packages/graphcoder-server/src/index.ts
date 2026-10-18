// @sovereign/graphcoder-server: Graphcoder's service and HTTP routes. A host
// (Sovereign's bootstrap, or a standalone server) supplies the ports and mounts
// the router.

export {
  createGraphcoderService,
  UnknownRepoError,
  type GraphcoderPorts,
  type GraphcoderService,
  type GraphcoderStatus,
  type RepoStats
} from './service.js'
export { createGraphcoderRouter } from './routes.js'
export { hasCodegraphIndex, indexPath, openCodegraphIndex } from './codegraph.js'
export { createNodeRepoFiles } from './repo-files.js'
