import { createSignal, Switch, Match, onCleanup, onMount } from 'solid-js'
import './app.css'

// Nav store (viewMode, drawerOpen, settingsOpen)
import { viewMode, drawerOpen, setDrawerOpen, initNavStore } from './features/nav/store.js'

// Thread store
import { threadKey, threads, switchThread, createThread, initThreadStore } from './features/threads/store.js'

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

// Theme store (used by SettingsModal internally)

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

export default function App() {
  // Recording state (local — no store for this yet)
  const [recordings, setRecordings] = createSignal<Recording[]>([])

  // Forward dialog state
  const [forwardOpen, setForwardOpen] = createSignal(false)
  const [forwardContent, _setForwardContent] = createSignal('')
  const [forwardAuthor, _setForwardAuthor] = createSignal('')
  const [forwardTimestamp, _setForwardTimestamp] = createSignal(0)

  // Init stores
  const cleanups: Array<() => void> = []

  onMount(() => {
    cleanups.push(initNavStore())

    // For now, init without WS
    cleanups.push(initThreadStore())
    const chatCleanup = initChatStore(threadKey)
    if (chatCleanup) cleanups.push(chatCleanup)
  })

  onCleanup(() => {
    cleanups.forEach((fn) => fn())
  })

  const chatMessages = (): ChatMessage[] => turns().map((turn) => ({ turn, pending: (turn as any).pending }))

  return (
    <div
      class="flex h-screen flex-col"
      style={{
        background: 'var(--c-bg)',
        color: 'var(--c-text)',
        'font-family': 'var(--c-font)'
      }}
    >
      <Header />

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
            <VoiceView />
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

      <SettingsModal />
    </div>
  )
}
