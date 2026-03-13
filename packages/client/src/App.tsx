import { createSignal, Switch, Match, onCleanup, onMount } from 'solid-js'
import './app.css'

// Nav store (viewMode, drawerOpen, settingsOpen)
import {
  viewMode,
  setViewMode,
  drawerOpen,
  setDrawerOpen,
  settingsOpen,
  setSettingsOpen,
  initNavStore
} from './features/nav/store.js'

// Thread store
import { threadKey, threads, switchThread, createThread, initThreadStore } from './features/threads/store.js'
import type { ThreadInfo } from './features/threads/store.js'
import { getThreadDisplayName } from './features/threads/helpers.js'

// Chat store
import {
  turns,
  streamingHtml,
  agentStatus,
  liveWork,
  liveThinkingText,
  compacting,
  isRetryCountdownActive,
  retryCountdownSeconds,
  sendMessage,
  abortChat,
  initChatStore
} from './features/chat/store.js'
import type { ChatMessage } from './features/chat/types.js'

// Voice store
import { voiceState, startRecording, stopRecording, interruptPlayback } from './features/voice/store.js'

// Connection store
// import { connectionStatus, initConnectionStore } from './features/connection/store.js'

// Theme store
import { currentTheme, setTheme } from './features/theme/store.js'

// Components
import { Header } from './features/nav/Header.js'
import { ThreadDrawer } from './features/threads/ThreadDrawer.js'
import { ChatView } from './features/chat/ChatView.js'
import { VoiceView } from './features/voice/VoiceView.js'
import { DashboardView } from './features/dashboard/DashboardView.js'
import { RecordingView } from './features/voice/RecordingView.js'
import type { Recording } from './features/voice/RecordingView.js'
import { ForwardDialog } from './features/threads/ForwardDialog.js'
import { SettingsModal } from './features/nav/SettingsModal.js'
import { ConnectionBadge } from './features/connection/ConnectionBadge.js'

export default function App() {
  // Recording state (local — no store for this yet)
  const [recordings, setRecordings] = createSignal<Recording[]>([])
  const [recordingMs, setRecordingMs] = createSignal(0)

  // Forward dialog state
  const [forwardOpen, setForwardOpen] = createSignal(false)
  const [forwardContent, _setForwardContent] = createSignal('')
  const [forwardAuthor, _setForwardAuthor] = createSignal('')
  const [forwardTimestamp, _setForwardTimestamp] = createSignal(0)

  // Recording timer
  let recordingTimer: ReturnType<typeof setInterval> | null = null

  // Init stores
  const cleanups: Array<() => void> = []

  onMount(() => {
    cleanups.push(initNavStore())

    // TODO: Wire WsStore when server is ready
    // const ws = createWsStore(...)
    // cleanups.push(initConnectionStore(ws))
    // cleanups.push(initThreadStore(ws))
    // cleanups.push(initChatStore(threadKey, ws) ?? (() => {}))

    // For now, init without WS
    cleanups.push(initThreadStore())
    const chatCleanup = initChatStore(threadKey)
    if (chatCleanup) cleanups.push(chatCleanup)
  })

  onCleanup(() => {
    cleanups.forEach((fn) => fn())
    if (recordingTimer) clearInterval(recordingTimer)
  })

  // Derived
  const threadName = () => {
    const key = threadKey()
    const t = threads().find((t: ThreadInfo) => t.key === key)
    return t ? getThreadDisplayName(t) : key
  }

  const chatMessages = (): ChatMessage[] => turns().map((turn) => ({ turn, pending: (turn as any).pending }))

  // Voice handlers
  const handleVoiceStart = async () => {
    setRecordingMs(0)
    recordingTimer = setInterval(() => setRecordingMs((ms) => ms + 100), 100)
    await startRecording()
  }

  const handleVoiceStop = async () => {
    if (recordingTimer) {
      clearInterval(recordingTimer)
      recordingTimer = null
    }
    const text = await stopRecording()
    if (text) {
      sendMessage(text)
      setViewMode('chat')
    }
  }

  const handleVoiceInterrupt = () => {
    if (recordingTimer) {
      clearInterval(recordingTimer)
      recordingTimer = null
    }
    interruptPlayback()
  }

  return (
    <div
      class="flex h-screen flex-col"
      style={{
        background: 'var(--c-bg)',
        color: 'var(--c-text)',
        'font-family': 'var(--c-font)'
      }}
    >
      <Header
        drawerOpen={drawerOpen}
        setDrawerOpen={setDrawerOpen}
        viewMode={viewMode}
        setViewMode={setViewMode}
        threadName={threadName}
        connectionBadge={() => <ConnectionBadge />}
        setSettingsOpen={setSettingsOpen}
      />

      <ThreadDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        threads={threads}
        activeKey={threadKey}
        onSwitchThread={(key: string) => {
          switchThread(key)
          setDrawerOpen(false)
        }}
        onNewThread={() => createThread()}
      />

      {/* Backdrop for drawer */}
      {drawerOpen() && <div class="fixed inset-0 z-40 bg-black/30" onClick={() => setDrawerOpen(false)} />}

      <main class="flex-1 overflow-hidden pt-12">
        <Switch>
          <Match when={viewMode() === 'chat'}>
            <ChatView
              messages={chatMessages()}
              streamingHtml={streamingHtml()}
              agentStatus={agentStatus()}
              liveWork={liveWork()}
              liveThinkingText={liveThinkingText()}
              compacting={compacting()}
              isRetryCountdownActive={isRetryCountdownActive()}
              retryCountdownSeconds={retryCountdownSeconds()}
              onSend={sendMessage}
              onAbort={abortChat}
              threadKey={threadKey()}
            />
          </Match>
          <Match when={viewMode() === 'voice'}>
            <VoiceView
              state={voiceState}
              recordingMs={recordingMs}
              onStart={handleVoiceStart}
              onStop={handleVoiceStop}
              onInterrupt={handleVoiceInterrupt}
            />
          </Match>
          <Match when={viewMode() === 'dashboard'}>
            <DashboardView />
          </Match>
          <Match when={viewMode() === 'recording'}>
            <RecordingView
              recordings={recordings}
              onDelete={(id: string) => setRecordings((prev) => prev.filter((r) => r.id !== id))}
              onExport={(rec: Recording) => {
                const url = URL.createObjectURL(rec.blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `recording-${rec.id}.webm`
                a.click()
                URL.revokeObjectURL(url)
              }}
            />
          </Match>
        </Switch>
      </main>

      <ForwardDialog
        open={forwardOpen}
        onClose={() => setForwardOpen(false)}
        threads={threads}
        currentThreadKey={threadKey}
        messageContent={forwardContent}
        messageAuthor={forwardAuthor}
        messageTimestamp={forwardTimestamp}
        onForward={(targetKey: string, note: string) => {
          // TODO: implement forwarding via WS
          console.log('Forward to', targetKey, 'with note:', note)
        }}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={currentTheme}
        setTheme={setTheme as (t: string) => void}
      />
    </div>
  )
}
