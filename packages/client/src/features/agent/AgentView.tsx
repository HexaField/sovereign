// Agent context view — the single-agent interface accessed via the ⬡ icon.
// Contains tabs: Hex (presence thread chat), Overview (dashboard),
// Settings, and System.
//
// The Hex tab reuses the global chat infrastructure. When the user enters
// agent mode, Header.tsx switches threadKey to the presence gateway thread;
// the chat store (already initialised at App level) follows that signal
// and reconnects automatically.

import { Switch, Match, Show, lazy, Suspense, createSignal, createMemo } from 'solid-js'
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
import { showSimpleView, simpleConversationEntries } from '../chat/simple-conversation-store.js'

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

  /** Convert simple conversation entries to ChatMessage[] for the summary
   *  mode ChatView. Maps 'hex' → 'assistant', string timestamps → numbers,
   *  and fills empty workItems/thinkingBlocks.
   *
   *  Using createMemo so Solid.js tracks `simpleConversationEntries()` as
   *  an explicit reactive dependency — avoids a stale-closure issue that
   *  can occur when a plain function is evaluated inside a prop ternary
   *  nested inside Switch/Match. */
  const summaryMessages = createMemo((): ChatMessage[] =>
    simpleConversationEntries().map((entry) => ({
      turn: {
        role: entry.role === 'hex' ? ('assistant' as const) : ('user' as const),
        content: entry.text,
        timestamp: new Date(entry.timestamp).getTime(),
        workItems: [],
        thinkingBlocks: [],
        origin: entry.modality !== 'text' ? { modality: entry.modality } : undefined
      }
    }))
  )

  /** Memoized display messages — switches between the full turn list and
   *  the simplified conversation when the toggle fires. createMemo gives
   *  Solid a stable reactive node to subscribe to, ensuring ChatView's
   *  `For each` re-renders immediately when showSimpleView changes. */
  const displayMessages = createMemo((): ChatMessage[] => (showSimpleView() ? summaryMessages() : props.messages()))

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
        <div
          style={{ position: 'relative', display: 'flex', 'flex-direction': 'column', flex: '1', 'min-height': '0' }}
        >
          {/* Simple-view mode strip — visible only in summary mode so the
              user always knows which view is active. */}
          <Show when={showSimpleView()}>
            <div
              class="flex shrink-0 items-center justify-center gap-1.5 px-3 py-1 text-xs"
              style={{
                background: 'color-mix(in srgb, var(--c-accent) 12%, var(--c-bg-raised))',
                'border-bottom': '1px solid color-mix(in srgb, var(--c-accent) 30%, var(--c-border))',
                color: 'var(--c-accent)'
              }}
            >
              <span>⬡</span>
              <span>Simple conversation — voice exchanges only</span>
            </div>
          </Show>
          <ChatView
            messages={displayMessages()}
            streamingHtml={showSimpleView() ? '' : streamingHtml()}
            agentStatus={agentStatus()}
            liveWork={showSimpleView() ? [] : liveWork()}
            liveThinkingText={liveThinkingText()}
            compacting={showSimpleView() ? false : compacting()}
            isRetryCountdownActive={showSimpleView() ? false : isRetryCountdownActive()}
            retryCountdownSeconds={showSimpleView() ? 0 : retryCountdownSeconds()}
            onViewSubagent={pushSubagent}
            onSend={sendMessage}
            onAbort={abortChat}
            threadKey={threadKey()}
            mode={showSimpleView() ? 'summary' : 'full'}
          />
        </div>
        <InputArea onSend={sendMessage} onAbort={abortChat} agentStatus={agentStatus()} threadKey={threadKey()} />
      </Show>
    </div>
  )
}
