// Personality compiler — assembles `~/.claude/CLAUDE.md` (the user-global
// Claude Code system prompt) by concatenating per-concern Markdown source
// files in the order declared by the manifest passed in at construction
// time (sourced from `config.personality`).
//
// Output is an exact concatenation: `files.map(read).join(separator)`. No
// fence markers, no header, no managed-by banner — the compiler owns the
// whole file. Anything you want in the personality belongs in a source file
// listed in the manifest.
//
// Recompiles on every change to a source `.md` file, and on explicit
// `setManifest(...)` calls (used by bootstrap when `config.personality`
// changes via the API).

import fs from 'node:fs'
import path from 'node:path'

export interface PersonalityManifest {
  /** Source files in assembly order. */
  files: string[]
  /** String inserted between concatenated source bodies. */
  separator: string
}

export interface PersonalityCompilerOptions {
  /** Directory holding the source `.md` files. */
  sourceDir: string
  /** Initial assembly order + separator. */
  manifest: PersonalityManifest
  /** Absolute path to the assembled output (default: `~/.claude/CLAUDE.md`). */
  outputPath?: string
  /** Debounce window for batched writes when multiple files change in quick succession. */
  debounceMs?: number
  /** Optional logger override. Defaults to console.log/warn. */
  log?: (msg: string) => void
}

export interface PersonalityCompiler {
  /** Read sources, write the assembled output once. Returns true if output changed. */
  compile(): boolean
  /** Replace the in-memory manifest. Triggers a debounced recompile. */
  setManifest(manifest: PersonalityManifest): void
  /** Begin watching the source dir for `.md` changes. Idempotent. */
  start(): void
  /** Stop watching. Idempotent. */
  stop(): void
  /** Read-only view of the source files that contributed to the last compile. */
  currentOrder(): string[]
}

const DEFAULT_DEBOUNCE_MS = 200

export function createPersonalityCompiler(opts: PersonalityCompilerOptions): PersonalityCompiler {
  const sourceDir = opts.sourceDir
  const outputPath = opts.outputPath ?? path.join(process.env.HOME ?? '', '.claude', 'CLAUDE.md')
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const log = opts.log ?? ((msg: string) => console.log(`[personality] ${msg}`))

  let manifest: PersonalityManifest = { files: [...opts.manifest.files], separator: opts.manifest.separator }
  let watcher: fs.FSWatcher | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let lastOrder: string[] = []

  /** CLAUDE.md is the compiled OUTPUT target (the SDK reads it from
   *  ~/.claude/CLAUDE.md AND via cwd walk-up). A CLAUDE.md sitting in the
   *  source dir gets read by the SDK alongside the compiled output, doubling
   *  the personality content. Warn loudly so the user notices and removes /
   *  renames it. */
  function warnIfDuplicateOutputInSourceDir(): void {
    const duplicate = path.join(sourceDir, 'CLAUDE.md')
    if (fs.existsSync(duplicate) && duplicate !== outputPath) {
      log(
        `WARNING: ${duplicate} exists in the source dir. Claude Code's cwd walk-up will read ` +
          `it alongside the compiled ${outputPath}, doubling the personality content. ` +
          `Rename it (e.g. to CLAUDE.md.bak) or delete it.`
      )
    }
  }

  function assemble(): string | null {
    warnIfDuplicateOutputInSourceDir()
    const sections: string[] = []
    const presentFiles: string[] = []
    for (const name of manifest.files) {
      if (name === 'CLAUDE.md') {
        log(
          `WARNING: manifest lists CLAUDE.md as a source — refusing to include it. ` +
            `CLAUDE.md is the compiled output target and would feed back as a source on the next save.`
        )
        continue
      }
      const filePath = path.join(sourceDir, name)
      if (!fs.existsSync(filePath)) {
        log(`source file listed but missing — skipping: ${name}`)
        continue
      }
      try {
        const body = fs.readFileSync(filePath, 'utf-8').trimEnd()
        if (body.length === 0) continue
        sections.push(body)
        presentFiles.push(name)
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log(`read failed for ${name}: ${errMsg}`)
      }
    }
    lastOrder = presentFiles
    if (sections.length === 0) {
      log('no source content to assemble — leaving output untouched')
      return null
    }
    return sections.join(manifest.separator) + '\n'
  }

  function writeIfChanged(content: string): boolean {
    let existing = ''
    try {
      existing = fs.readFileSync(outputPath, 'utf-8')
    } catch {
      /* output doesn't exist yet */
    }
    if (content === existing) return false
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    const tmp = outputPath + '.tmp'
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, outputPath)
    return true
  }

  function compileOnce(): boolean {
    const assembled = assemble()
    if (assembled === null) return false
    const changed = writeIfChanged(assembled)
    if (changed) {
      const sizeKb = (assembled.length / 1024).toFixed(1)
      log(`compiled ${manifest.files.length} source(s) → ${outputPath} (${sizeKb} KB)`)
    }
    return changed
  }

  function scheduleRecompile(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      try {
        compileOnce()
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log(`recompile failed: ${errMsg}`)
      }
    }, debounceMs)
  }

  return {
    compile: compileOnce,
    setManifest(next) {
      manifest = { files: [...next.files], separator: next.separator }
      scheduleRecompile()
    },
    start() {
      if (watcher) return
      if (!fs.existsSync(sourceDir)) {
        log(`cannot watch — source dir missing: ${sourceDir}`)
        return
      }
      // `recursive: false` — the source dir is flat. Filter inside the listener
      // so unrelated writes don't trigger work.
      watcher = fs.watch(sourceDir, { persistent: false }, (_evt, filename) => {
        if (!filename) {
          scheduleRecompile()
          return
        }
        const name = filename.toString()
        if (name.endsWith('.md')) {
          scheduleRecompile()
        }
      })
      log(`watching ${sourceDir} for personality changes`)
    },
    stop() {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      if (watcher) {
        watcher.close()
        watcher = null
      }
    },
    currentOrder() {
      return [...lastOrder]
    }
  }
}
