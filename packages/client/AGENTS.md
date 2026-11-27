# Client (`packages/client/`)

## Dictation: the draft bubble

While speech-to-text streams, the transcript shows in the thread as an outlined user bubble with a recording dot (`chat/VoiceDraftBubble.tsx`), not in the input bar, so the chat area is room to read it. `InputArea` publishes the draft through `chat/voice-draft-store.ts`; `ChatView` renders it for its own thread and routes edits back. Tap the bubble to pause the mic and edit in place; blur resumes; Enter sends.

- **Dictation state is module-level** in `InputArea.tsx` (`editingTranscript`, `voiceUsedForMessage`): a phone mounts two input areas and two chat views (a hidden desktop panel behind the full-screen chat). Per-instance state let the hidden one enter edit mode while the visible one, which owns the mic, overwrote the edit. Only the visible bubble's editor takes focus.
- **A resume starts a new segment after the current text** (`voice/streaming.ts`), so edits made while paused stay. A paused segment's final transcript that lands after the resume is dropped (`owedFinals`); one that lands while the user edits is ignored by `InputArea`.
- **Server path:** wind-tunnel s38 drives `voice-stream.start/chunk/stop` against the mock `/transcribe` and checks the interim and final transcripts.

## File quick-open (Cmd+P / Ctrl+P)

- **Key:** `isQuickOpenKey` in `hooks/useKeyboardShortcuts.ts` — Cmd+P on macOS (Ctrl+P stays "previous line" in text fields), Ctrl+P (or Cmd/Super+P) elsewhere, never inside the terminal (`.xterm`, Ctrl+P is the shell's previous command). Cmd+K and Cmd/Ctrl+P close each other's palette.
- **Server:** `GET /api/files/search?root=<root id or path>&q=&limit=` (`packages/files/src/file-search.ts`); the root must be one of `/api/files/roots`. The file list comes from `rg --files --hidden -g '!.git' --null` (honours `.gitignore`; looked up on PATH, then `~/.local/bin`, `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`), else a walk that skips `node_modules`/`.git`/`dist`/`build`/`target`/`.venv`. Lists cap at 500k files and are cached 30 s per root (stale served while a fresh one builds). Scoring: query characters in order, file-name matches first, word starts and runs score more; the top N is kept while scanning, so a one-letter query over ~300k files stays near 100 ms.
- **Client:** `features/workspace/FileQuickOpen.tsx` searches the root whose id matches the active workspace (else `_global`), lists recent tabs before typing, and opens the pick with `sovereign:open-file` (which also switches the main view to files).

## File panel tree (`features/workspace/panels/FilePanel.tsx`, `file-tree.ts`)

- **Follows the open file** (as VS Code does): whenever the active file changes, the panel expands its root and every folder above it, and scrolls its row into view; opening the drawer (or the mobile tree) scrolls to it again.
- **Loading follows the expanded set.** `expandedDirs` is persisted and shared by every FilePanel instance (the app mounts more than one, each with a desktop drawer and an `md:hidden` mobile copy), but each instance loads its own `treeMaps`. An effect loads the children of any expanded folder whose parent is loaded and whose own children are not — so state restored on mount, or set by another instance, fills in. Toggling a folder only changes the set.
- **Refresh** (`file.changed`) refetches the top level and every expanded folder together and swaps them in at once; replacing only the top level collapsed every open folder.
- Rows carry `data-tree-path` (absolute path); the scroll moves only the tree's own scroll box.

## File chips in messages (`packages/client/src/lib/markdown.ts`)

`renderMarkdown` turns file references in rendered HTML into `.file-chip` spans (click opens the file, ⧉ copies the path). `injectFileChips` runs in phases over marked's output:

| Phase | Matches | Chips when |
| --- | --- | --- |
| 0 | Markdown links `[label](href)` with a local href (`/abs`, `~/…`, `file://`, relative) | Always for absolute and `~/` hrefs; for relative or bare names, when the name is known |
| 1 | Plain-text `/abs/…` and `~/…` paths ending in `.ext` (1–10 chars); skips `<a>`, `<code>`, `<pre>` content | The path is a known file, or the server confirms it is a file |
| 2a | A whole inline code span `` `x` ``: an absolute or `~/` path (as Phase 1), else a relative path or a bare filename | Known, or (absolute/`~/`) confirmed by the server |
| 2b | Plain-text relative paths and bare filenames (longest first) | The name is known |

- **Known files** come from two lists the client loads per workspace: each project's tree (`/api/files/tree`, depth 4) and the Sovereign workspace (`/api/files/workspace`, depth 8, minus the runtime data dir). A bare filename maps to the first file with that name. An absolute or `~/` path in neither list (an org's `.specs`, another repo) is checked once with `POST /api/files/exists` (batched, files under the home dir only); the answer is cached per path and a found file re-renders as a chip (`wsFilesVersion` bump).
- `~/` expands with a home dir taken from the first known `/home/<u>/` or `/Users/<u>/` path.
- Never chipped: relative paths and bare names no list knows, absolute paths that are not files under the home dir, paths inside fenced code blocks, paths without an extension, paths with characters outside `[\w.+-]` (spaces, `@`).
- Results cache per text and workspace-list version: a message renders again once the lists arrive.
- **Opening a chip** (`lib/file-chip-handlers.ts`) and the **file viewer** (`FilePanel.tsx`) pick a view with `lib/file-view.ts`: HTML renders as a page in an iframe, images (png, jpg, gif, webp, svg…) as `<img>`, markdown rendered, anything else as text. HTML and images load from `GET /api/files/view/<absolute path>` (files under the home dir; `/view/~/…` expands). The path sits in the URL path so a page's relative links (`x.json`, CSS) resolve beside it. HTML and SVG responses carry `Content-Security-Policy: sandbox allow-scripts …`, and the iframe has the same `sandbox`: scripts run, but in an opaque origin with no access to Sovereign's API or storage — also when the page is opened in its own tab. A page's `fetch()` of a sibling file fails (cross-origin from the opaque origin; no CORS on purpose), so pages should embed their data. In the viewer, Edit shows the source.
- **Mermaid** (`lib/mermaid.ts`): in the file viewer and the chip preview, each ` ```mermaid ` block renders as an SVG after the HTML is in the DOM (`renderMermaidIn`). Mermaid loads by dynamic import on the first diagram (its own chunk; ELK layouts are bundled in mermaid 12), runs with `securityLevel: 'strict'`, and uses the dark theme except for Sovereign's `light` theme. A block that fails to parse keeps its source with the error above it. The file viewer re-renders on a theme change. Chat messages do not render diagrams. Labels are measured off-page, so `.mermaid-diagram foreignObject p` resets the page's paragraph styles — keep that rule if the viewer's prose classes change.
