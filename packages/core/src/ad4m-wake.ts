/**
 * The text of an AD4M mention wake, and how many messages before the mention
 * it carries. Config (`ad4m.wake`) holds it; the waker reads it at every wake.
 *
 * Template syntax:
 * - `{name}` is replaced by a value. An unknown name stays as written.
 * - `[[ ... ]]` is a segment: if any placeholder inside it is empty, the whole
 *   segment is left out. It may span lines.
 * - A line that is empty after rendering is dropped.
 *
 * Template placeholders: `{body}` (the text), `{address}` (the item),
 * `{author}`, `{verified}` (a label below), `{timestamp}`, `{via}` (a label
 * below), `{parents}`, `{ancestors}`, `{context}` (the preceding messages, one
 * `contextLine` each).
 *
 * `contextLine` placeholders: `{author}` (last 6 characters of the DID),
 * `{time}` (HH:MM:SS, UTC), `{text}` (clipped).
 */
export interface Ad4mWakeConfig {
  template: string
  /** How many messages before the item (same parent) the wake carries. 0 = none. */
  contextMessages: number
  contextLine: string
  labels: {
    verified: string
    unverified: string
    /** `{via}` when a mention link woke the agent. */
    viaLink: string
    /** `{via}` when the agent's name or DID in the text woke it. */
    viaText: string
    /** `{parents}` when the mention has none. */
    unknownParents: string
  }
}

export const DEFAULT_AD4M_WAKE: Ad4mWakeConfig = {
  template: [
    '[AD4M] You were mentioned[[: "{body}"]]',
    'Item: {address}',
    '[[By: {author} ({verified})]]',
    '[[At: {timestamp}]]',
    '[[Matched by: {via}]]',
    'Parents: {parents}',
    '[[Ancestors: {ancestors}]]',
    '[[Before it:',
    '{context}]]'
  ].join('\n'),
  contextMessages: 5,
  contextLine: '{author} {time}: {text}',
  labels: {
    verified: 'signature verified',
    unverified: 'signature NOT verified',
    viaLink: 'a mention link',
    viaText: 'your name or DID in the text; a mention link may also exist',
    unknownParents: '(unknown)'
  }
}
