import { describe, it } from 'vitest'

describe('§4.1 ChatView', () => {
  it.todo('MUST render conversation turns as a vertically scrollable list')
  it.todo('MUST auto-scroll to bottom when new messages arrive')
  it.todo('MUST pause auto-scroll when user scrolls up more than 80px from bottom')
  it.todo('MUST show scroll to bottom floating button when user has scrolled up and new content arrived')
  it.todo('MUST re-enable auto-scroll when scroll to bottom button is clicked')
  it.todo('MUST use double-requestAnimationFrame for scroll-after-render')
  it.todo('MUST show streaming indicator (pulsing dots) when streamingHtml is non-empty')
  it.todo('MUST show compaction indicator when compacting is true')
  it.todo('MUST show rate-limit retry countdown when isRetryCountdownActive is true')
  it.todo('MUST render each turn using MessageBubble component')
  it.todo('MUST render work items using WorkSection component')
  it.todo('MUST use inline Tailwind classes with var(--c-*) theme tokens')
})
