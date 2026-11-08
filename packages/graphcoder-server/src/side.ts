// One commit's code as Graphcoder reads it: the index snapshot, the test
// files, the package manifests and the concept tree mapped onto the code.
// Shared by the structure of a change (both sides) and the concept map.

import {
  createConceptMap,
  readConceptTree,
  readPackages,
  type CodeGraphHandle,
  type GraphSnapshot,
  type StructureSide
} from '@sovereign/graphcoder-core'
import { createNodeRepoFiles } from './repo-files.js'
import { readTestFiles } from './test-files.js'

/** Every node and edge of an open index; closes the handle */
export function takeSnapshot(handle: CodeGraphHandle): GraphSnapshot {
  try {
    return handle.snapshot()
  } finally {
    handle.close()
  }
}

/** The checkout at `dir` whose index `snapshot` was read from; `conceptDir`: its concept tree folder */
export async function readSide(dir: string, snapshot: GraphSnapshot, conceptDir: string): Promise<StructureSide> {
  const files = createNodeRepoFiles(dir)
  const filePaths = snapshot.nodes.filter((n) => n.kind === 'file').map((n) => n.filePath)
  const [{ testFiles, testRanges }, packages, tree] = await Promise.all([
    readTestFiles(files, snapshot.nodes),
    readPackages(files, filePaths),
    readConceptTree(files, conceptDir)
  ])
  return {
    snapshot,
    testFiles,
    testRanges,
    packages,
    ...(tree ? { concepts: createConceptMap(tree, snapshot.nodes) } : {})
  }
}
