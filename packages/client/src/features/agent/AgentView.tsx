// Agent context view — the single-agent interface accessed via the ⬡ icon.
// Contains tabs: Hex (presence thread chat), Overview (dashboard),
// Settings, and System.
//
// The Hex tab reuses the global chat infrastructure. When the user enters
// agent mode, Header.tsx switches threadKey to the presence gateway thread;
// the chat store (already initialised at App level) follows that signal
// and reconnects automatically.

import { Switch, Match, Show, lazy, Suspense, createSignal } from 'solid-js'
import { activeAgentTab } from '../nav/store.js'
import { ChatView } from '../chat/ChatView.js'
import { InputArea } from '../chat/InputArea.js'
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
  abortChat
} from '../chat/store.js'
import { threadKey } from '../threads/store.js'
import { SubagentView } from '../chat/SubagentView.js'
import type { SubagentNavEntry } from '../chat/SubagentView.js'
import type { ChatMessage } from '../chat/types.js'
import { showSimpleView } from '../chat/simple-conversation-store.js'
import { SimpleConversationView } from '../chat/SimpleConversationView.js'

// Lazy-loaded tabs
const DashboardView = lazy(() => import('../dashboard/DashboardView.js'))
const ForestView = lazy(() => import('../forest/ForestView.js'))
const SystemView = lazy(() => import('../system/SystemView.js'))
const SettingsContent = lazy(() => import('./SettingsContent.js'))

// Subagent navigation for the Hex chat
const [subagentNavStack, setSubagentNavStack] = createSignal<SubagentNavEntry[]>([])

function pushSubagent(sessionKey: string, label: string): void {
  setSubagentNavStack((prev) => [...prev, { sessionKey, label }])
}

function popSubagent(): void {
  setSubagentNavStack((prev) => (prev.length <= 1 ? [] : prev.slice(0, -1)))
}

function navigateToDepth(depth: number): void {
  if (depth === -1) setSubagentNavStack([])
  else setSubagentNavStack((prev) => prev.slice(0, depth + 1))
}

export default function AgentView() {
  const messages = (): ChatMessage[] => turns().map((t) => ({ turn: t }))

  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)' }}>
      <Suspense>
        <Switch>
          <Match when={activeAgentTab() === 'hex'}>
            <HexTab messages={messages} />
          </Match>
          <Match when={activeAgentTab() === 'overview'}>
            <DashboardView />
          </Match>
          <Match when={activeAgentTab() === 'forest'}>
            <ForestView />
          </Match>
          <Match when={activeAgentTab() === 'settings'}>
            <SettingsContent />
          </Match>
          <Match when={activeAgentTab() === 'system'}>
            <SystemView />
          </Match>
        </Switch>
      </Suspense>
    </div>
  )
}

/** Hex tab — presence thread chat (full-screen). */
function HexTab(props: { messages: () => ChatMessage[] }) {
  const currentSubagent = () => {
    const stack = subagentNavStack()
    return stack.length > 0 ? stack[stack.length - 1] : null
  }

  return (
    <div class="flex h-full flex-col">
      <Show
        when={!currentSubagent()}
        fallback={
          <SubagentView
            navStack={subagentNavStack()}
            parentLabel="Hex"
            onBack={popSubagent}
            onNavigateTo={navigateToDepth}
            onViewSubagent={pushSubagent}
          />
        }
      >
        <Show
          when={!showSimpleView()}
          fallback={
            <div
              style={{
                position: 'relative',
                display: 'flex',
                'flex-direction': 'column',
                flex: '1',
                'min-height': '0'
              }}
            >
              <SimpleConversationView />
            </div>
          }
        >
          <div
            style={{ position: 'relative', display: 'flex', 'flex-direction': 'column', flex: '1', 'min-height': '0' }}
          >
            <ChatView
              messages={props.messages()}
              streamingHtml={streamingHtml()}
              agentStatus={agentStatus()}
              liveWork={liveWork()}
              liveThinkingText={liveThinkingText()}
              compacting={compacting()}
              isRetryCountdownActive={isRetryCountdownActive()}
              retryCountdownSeconds={retryCountdownSeconds()}
              onViewSubagent={pushSubagent}
              onSend={sendMessage}
              onAbort={abortChat}
              threadKey={threadKey()}
            />
          </div>
        </Show>
        <InputArea onSend={sendMessage} onAbort={abortChat} agentStatus={agentStatus()} threadKey={threadKey()} />
      </Show>
    </div>
  )
}
