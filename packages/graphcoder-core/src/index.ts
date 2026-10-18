// @sovereign/graphcoder-core: Graphcoder's pure core. No runtime dependencies
// and no I/O: the index, git, files and models come in through the ports.

export type * from './graph.js'
export type * from './ports.js'
export type * from './contract.js'

export { sha256Hex } from './sha256.js'
export {
  buildDiffIdMap,
  createMemberResolver,
  nodeSemanticId,
  normalizeSignature,
  semanticId,
  type MemberRef
} from './identity.js'

export type { ArchDiff, ArchOp, EdgeTuple, LocationHint, NodeProps, NodeSnapshot } from './diff/types.js'
export { canonicalJson, computeDiffHash, snapshotHash } from './diff/hash.js'
export { byCodeUnit, computeArchDiff, edgeKey, sortOps } from './diff/compute.js'
export { compose } from './diff/compose.js'

export type {
  Annotation,
  AnnotationKind,
  AnnotationMember,
  AnnotationShape,
  AnnotationStatus,
  ModuleDependency,
  ModuleSpec
} from './annotations/types.js'
export { deriveShape } from './annotations/types.js'
export {
  ANNOTATIONS_DIR,
  canonicalFileJson,
  createAnnotation,
  deleteAnnotation,
  isSlug,
  loadAllAnnotations,
  loadAnnotation,
  parseAnnotation,
  saveAnnotation,
  slugify,
  toCommitted,
  type NewAnnotation
} from './annotations/store.js'
export {
  deleteKind,
  ensureKind,
  findKind,
  KIND_PALETTE,
  KINDS_FILE,
  loadKinds,
  saveKinds,
  syncKindsFromAnnotations,
  updateKind
} from './annotations/kinds.js'
export { findStaleAnnotations, resolveAnnotation, type ResolutionResult } from './annotations/resolve.js'

export {
  COMMON_NAMES,
  createEdgeHygiene,
  DEPENDENCY_EDGE_KINDS,
  importedNames,
  isTestPath,
  MIN_CONFIDENCE,
  nameNoise,
  type EdgeHygiene,
  type EdgeHygieneOptions,
  type EdgeRejection,
  type PackageInfo,
  type TestRanges
} from './hygiene.js'
export { parseCargoManifest, parsePackageJson, readPackages } from './manifests.js'

export { hunkLines, parseUnifiedDiff } from './structure/unified-diff.js'
export { changedSymbols, isSymbol, symbolsOnLines, type SymbolChanges } from './structure/changes.js'
export { directoryModules, type ModuleId, type ModuleOf } from './structure/modules.js'
export { changeReach, type ChangeReach } from './structure/reach.js'
export {
  REACH_EDGE_KINDS,
  seedBelongsTo,
  testsReaching,
  type TestCase,
  type TestFile,
  type TestReachOptions
} from './structure/test-reach.js'
export { matchingBrace, rustTestCases, rustTestRanges } from './structure/rust-tests.js'
export {
  computeChangeStructure,
  symbolRef,
  testCodeOf,
  testEdgeFilter,
  type ChangeStructureInput,
  type StructureSide
} from './structure/compute.js'
export { createMemoryFiles } from './memory-files.js'
