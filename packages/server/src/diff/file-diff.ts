// File diff via git module

import type { FileDiff } from './types.js'

export function diffFile(_projectPath: string, _filePath: string, _base: string, _head: string): Promise<FileDiff> {
  throw new Error('not implemented')
}

export function diffWorking(_projectPath: string, _opts?: { staged?: boolean }): Promise<FileDiff[]> {
  throw new Error('not implemented')
}
