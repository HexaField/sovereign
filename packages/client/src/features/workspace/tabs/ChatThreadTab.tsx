import type { Component } from 'solid-js'

/** Components reused by ChatThreadTab */
export const REUSED_COMPONENTS = ['ChatView', 'InputArea', 'MessageBubble', 'MarkdownContent', 'WorkSection'] as const

/** Build a WS channel name scoped to a thread key */
export function threadWsChannel(threadKey: string): string {
  return `chat:thread:${threadKey}`
}

/** Forward a message to another thread key — returns the target channel */
export function forwardMessage(
  messageId: string,
  fromThread: string,
  toThread: string
): { sourceChannel: string; targetChannel: string; messageId: string } {
  return {
    sourceChannel: threadWsChannel(fromThread),
    targetChannel: threadWsChannel(toThread),
    messageId
  }
}

const ChatThreadTab: Component = () => <div />

export default ChatThreadTab
