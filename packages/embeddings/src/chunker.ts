/**
 * Text chunking for the embedding pipeline.
 * Splits documents into overlapping chunks sized for the embedding model's
 * context window (nomic-embed-text-v1.5: 2048 tokens ≈ 8192 chars).
 *
 * Chunks split on paragraph boundaries when possible, falling back to
 * sentence boundaries, then hard character limits.
 */

export interface ChunkOptions {
  /** Target chunk size in characters. Default: 1500. */
  chunkSize?: number
  /** Overlap between adjacent chunks in characters. Default: 200. */
  overlap?: number
  /** Minimum chunk size (discard shorter trailing chunks). Default: 100. */
  minSize?: number
}

export interface Chunk {
  text: string
  index: number
  startChar: number
  endChar: number
}

const PARAGRAPH_SPLIT = /\n\s*\n/
const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z])/

export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const chunkSize = opts.chunkSize ?? 1500
  const overlap = opts.overlap ?? 200
  const minSize = opts.minSize ?? 100

  const trimmed = text.trim()
  if (trimmed.length <= chunkSize) {
    return [{ text: trimmed, index: 0, startChar: 0, endChar: trimmed.length }]
  }

  // Split into paragraphs first
  const paragraphs = trimmed.split(PARAGRAPH_SPLIT)
  const chunks: Chunk[] = []
  let current = ''
  let currentStart = 0
  let charPos = 0

  for (const para of paragraphs) {
    const paraWithSep = para.trim()
    if (!paraWithSep) {
      charPos += para.length + 2 // account for \n\n
      continue
    }

    // If adding this paragraph exceeds the chunk size, flush
    if (current.length + paraWithSep.length + 2 > chunkSize && current.length > 0) {
      chunks.push({
        text: current.trim(),
        index: chunks.length,
        startChar: currentStart,
        endChar: currentStart + current.trim().length
      })
      // Overlap: keep the tail of the current chunk
      const overlapText = current.slice(-overlap)
      current = overlapText + '\n\n' + paraWithSep
      currentStart = charPos - overlapText.length
    } else {
      if (current.length === 0) {
        currentStart = charPos
        current = paraWithSep
      } else {
        current += '\n\n' + paraWithSep
      }
    }

    // Handle oversized paragraphs — split on sentences
    if (current.length > chunkSize) {
      const sentences = current.split(SENTENCE_SPLIT)
      let sentBuf = ''
      let sentStart = currentStart
      for (const sent of sentences) {
        if (sentBuf.length + sent.length + 1 > chunkSize && sentBuf.length > 0) {
          chunks.push({
            text: sentBuf.trim(),
            index: chunks.length,
            startChar: sentStart,
            endChar: sentStart + sentBuf.trim().length
          })
          const sentOverlap = sentBuf.slice(-overlap)
          sentBuf = sentOverlap + ' ' + sent
          sentStart = currentStart + current.indexOf(sent) - sentOverlap.length
        } else {
          sentBuf = sentBuf ? sentBuf + ' ' + sent : sent
        }
      }
      current = sentBuf
      currentStart = sentStart
    }

    charPos += para.length + 2
  }

  // Flush remaining
  if (current.trim().length >= minSize) {
    chunks.push({
      text: current.trim(),
      index: chunks.length,
      startChar: currentStart,
      endChar: currentStart + current.trim().length
    })
  }

  return chunks
}

/** Chunk a file's content, prepending the filename for context. */
export function chunkFile(filePath: string, content: string, opts: ChunkOptions = {}): Chunk[] {
  const chunks = chunkText(content, opts)
  // Prepend file path context to each chunk for better retrieval
  return chunks.map((c) => ({
    ...c,
    text: `File: ${filePath}\n\n${c.text}`
  }))
}
