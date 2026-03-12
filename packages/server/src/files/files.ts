import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { EventBus } from '@template/core'
import type { FileContent } from './types.js'

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.toml': 'toml',
  '.ini': 'ini',
  '.env': 'plaintext',
  '.txt': 'plaintext',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
  '.dockerfile': 'dockerfile'
}

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.zip',
  '.gz',
  '.tar',
  '.bz2',
  '.7z',
  '.pdf',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm'
])

export function detectLanguage(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase()
  const basename = path.basename(filePath).toLowerCase()
  if (basename === 'dockerfile') return 'dockerfile'
  if (basename === 'makefile') return 'makefile'
  return LANGUAGE_MAP[ext]
}

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export function validatePath(repoRoot: string, filePath: string): string {
  const resolved = path.resolve(repoRoot, filePath)
  if (!resolved.startsWith(path.resolve(repoRoot) + path.sep) && resolved !== path.resolve(repoRoot)) {
    throw new PathTraversalError(`Path "${filePath}" is outside the project repository`)
  }
  return resolved
}

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathTraversalError'
  }
}

export interface FileService {
  readFile(repoRoot: string, filePath: string): Promise<FileContent>
  writeFile(repoRoot: string, filePath: string, content: string): Promise<void>
  deleteFile(repoRoot: string, filePath: string): Promise<void>
}

export function createFileService(bus: EventBus): FileService {
  return {
    async readFile(repoRoot: string, filePath: string): Promise<FileContent> {
      const resolved = validatePath(repoRoot, filePath)
      const stat = await fs.stat(resolved)
      const binary = isBinary(filePath)
      const buffer = await fs.readFile(resolved)
      const content = binary ? buffer.toString('base64') : buffer.toString('utf-8')
      const encoding = binary ? ('base64' as const) : ('utf-8' as const)
      const language = detectLanguage(filePath)

      return {
        path: filePath,
        content,
        encoding,
        size: stat.size,
        ...(language ? { language } : {})
      }
    },

    async writeFile(repoRoot: string, filePath: string, content: string): Promise<void> {
      const resolved = validatePath(repoRoot, filePath)
      let isNew = false
      try {
        await fs.access(resolved)
      } catch {
        isNew = true
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, content, 'utf-8')
      if (isNew) {
        bus.emit({
          type: 'file.created',
          timestamp: new Date().toISOString(),
          source: 'file-service',
          payload: { repoRoot, path: filePath }
        })
      }
    },

    async deleteFile(repoRoot: string, filePath: string): Promise<void> {
      const resolved = validatePath(repoRoot, filePath)
      await fs.unlink(resolved)
      bus.emit({
        type: 'file.deleted',
        timestamp: new Date().toISOString(),
        source: 'file-service',
        payload: { repoRoot, path: filePath }
      })
    }
  }
}
