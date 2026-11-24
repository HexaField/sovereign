// The text of a mention wake: a template from config (`ad4m.wake`, see
// Ad4mWakeConfig in @sovereign/core for the syntax) filled with the mention.
import { DEFAULT_AD4M_WAKE, type Ad4mWakeConfig } from '@sovereign/core'

/** A message before the mentioned item, under the same parent. */
export interface PreviousMessage {
  author?: string
  timestamp?: string
  text: string
}

/** The fields of the SDK's `MentionMessage` that the wake text uses. */
export interface WakeMention {
  address: string
  author?: string
  verified: boolean
  timestamp?: string
  via?: 'mentions' | 'text' | string
  parents: string[]
  ancestors?: string[]
}

const CLIP = 200
const CONTEXT_CAP = 1200

/** Config as it stands (maybe partial, from a hand-edited file) over the defaults. */
export function resolveWake(
  raw: (Partial<Omit<Ad4mWakeConfig, 'labels'>> & { labels?: Partial<Ad4mWakeConfig['labels']> }) | undefined
): Ad4mWakeConfig {
  return {
    ...DEFAULT_AD4M_WAKE,
    ...raw,
    labels: { ...DEFAULT_AD4M_WAKE.labels, ...raw?.labels }
  }
}

/**
 * Fill `{name}` placeholders. A `[[...]]` segment with an empty placeholder
 * inside is left out; a line empty after rendering is dropped. One pass over
 * the template, so a value that looks like a placeholder is not expanded.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  const fill = (s: string, onEmpty: () => string): string => {
    let empty = false
    const out = s.replace(/\{(\w+)\}/g, (whole, name: string) => {
      if (!Object.prototype.hasOwnProperty.call(values, name)) return whole
      if (!values[name]) empty = true
      return values[name]
    })
    return empty ? onEmpty() : out
  }
  const rendered = template.replace(
    /\[\[([\s\S]*?)\]\]|\{(\w+)\}/g,
    (whole, segment: string | undefined, name: string | undefined) => {
      if (segment !== undefined) return fill(segment, () => '')
      return Object.prototype.hasOwnProperty.call(values, name!) ? values[name!] : whole
    }
  )
  return rendered
    .split('\n')
    .filter((line) => line.trim())
    .join('\n')
}

const clip = (s: string) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > CLIP ? `${flat.slice(0, CLIP)}…` : flat
}

/** One line per message, oldest first. The newest messages stay when the total passes the cap. */
export function contextLines(wake: Ad4mWakeConfig, previous: PreviousMessage[]): string[] {
  const lines = previous.map((p) =>
    renderTemplate(wake.contextLine, {
      author: p.author ? `…${p.author.slice(-6)}` : '',
      time: p.timestamp?.slice(11, 19) ?? '',
      text: clip(p.text)
    })
  )
  const kept: string[] = []
  let total = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1
    if (kept.length && total - 1 > CONTEXT_CAP) break
    kept.unshift(lines[i])
  }
  return kept
}

export function wakeText(
  wake: Ad4mWakeConfig,
  m: WakeMention,
  body: string | undefined,
  previous: PreviousMessage[]
): string {
  const { labels } = wake
  return renderTemplate(wake.template, {
    body: body ?? '',
    address: m.address,
    author: m.author ?? '',
    verified: m.author ? (m.verified ? labels.verified : labels.unverified) : '',
    timestamp: m.timestamp ?? '',
    via: m.via ? (m.via === 'mentions' ? labels.viaLink : labels.viaText) : '',
    parents: m.parents.length ? m.parents.join(', ') : labels.unknownParents,
    ancestors: m.ancestors?.join(', ') ?? '',
    context: contextLines(wake, previous).join('\n')
  })
}
