// Browser module — public types. Manager keeps a Map<sessionId, BrowserSession>
// of long-lived Playwright pages; the MCP `sovereign.browser_*` tools call
// open/act/close against it.

export interface BrowserOpenOptions {
  /** URL to navigate to immediately after opening. */
  url: string
  /** Headed (visible) window. Defaults to false (headless). */
  headed?: boolean
  /** Viewport size hints. */
  viewport?: { width: number; height: number }
  /** Optional explicit session id to reuse — if already open, returns it. */
  sessionId?: string
}

export interface BrowserOpenResult {
  sessionId: string
  url: string
  title: string
  /** Compact ARIA snapshot of interactive elements, with refs the agent can pass back. */
  summary: string
}

/** Discriminated union of supported actions covering the page-level
 *  operations you'd run in a typical browse-and-extract workflow. */
export type BrowserAct =
  | { kind: 'navigate'; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  | {
      kind: 'click'
      ref?: string
      selector?: string
      x?: number
      y?: number
      doubleClick?: boolean
      button?: 'left' | 'middle' | 'right'
    }
  | { kind: 'type'; text: string; ref?: string; selector?: string; submit?: boolean }
  | { kind: 'fill'; text: string; ref?: string; selector?: string }
  | { kind: 'press'; key: string; ref?: string; selector?: string }
  | { kind: 'hover'; ref?: string; selector?: string }
  | { kind: 'scroll'; deltaX?: number; deltaY?: number; ref?: string; selector?: string }
  | { kind: 'wait'; timeMs?: number; selector?: string; loadState?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { kind: 'snapshot'; mode?: 'aria' | 'text' }
  | { kind: 'screenshot'; fullPage?: boolean; selector?: string }
  | { kind: 'evaluate'; fn: string }
  | { kind: 'extract'; selector?: string }
  | { kind: 'close' }

export interface BrowserActResult {
  /** Human-readable summary line for the agent (e.g. "clicked", "typed 'foo'"). */
  message: string
  /** Updated URL after the action. */
  url?: string
  /** Updated title. */
  title?: string
  /** Optional extracted text content (snapshot/extract/evaluate results). */
  text?: string
  /** Optional base64 image (screenshot). */
  imageBase64?: string
  /** MIME type when imageBase64 is set. */
  imageMime?: string
  /** Updated ARIA snapshot when the action moved the page. */
  summary?: string
}

export interface BrowserSessionSummary {
  sessionId: string
  url: string
  title: string
  openedAt: number
  lastActivity: number
}

export interface BrowserService {
  open(opts: BrowserOpenOptions): Promise<BrowserOpenResult>
  act(sessionId: string, action: BrowserAct): Promise<BrowserActResult>
  close(sessionId: string): Promise<void>
  list(): BrowserSessionSummary[]
  /** Tear everything down (used on shutdown). */
  dispose(): Promise<void>
}

export interface BrowserManagerConfig {
  /** Path to the Chrome / Chromium binary. Defaults to the system Chrome on macOS. */
  executablePath?: string
  /** Hard cap on concurrent sessions to keep system memory bounded. Default 4. */
  maxSessions?: number
  /** User-data directory root for managed browsers; default `<dataDir>/browser/profiles/`. */
  userDataRoot?: string
}
