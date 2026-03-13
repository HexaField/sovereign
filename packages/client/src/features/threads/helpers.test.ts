import { describe, it } from 'vitest'

describe('§5.5 Thread Helpers', () => {
  it.todo('getThreadDisplayName MUST derive name from primary entity (branch name)')
  it.todo('getThreadDisplayName MUST derive name from issue title + #number')
  it.todo('getThreadDisplayName MUST derive name from PR title + #number')
  it.todo('getThreadDisplayName MUST return label or "Main" for global threads')
  it.todo('getEntityIcon MUST return 🌿 for branch')
  it.todo('getEntityIcon MUST return 🎫 for issue')
  it.todo('getEntityIcon MUST return 🔀 for pr')
  it.todo('groupThreadsByWorkspace MUST group by {orgId}/{projectId} key')
  it.todo('groupThreadsByWorkspace MUST group global threads under "global" key')
  it.todo('formatRelativeTime MUST format as "Just now" for recent timestamps')
  it.todo('formatRelativeTime MUST format as "2m ago", "1h ago" for older timestamps')
  it.todo('formatRelativeTime MUST format as "Yesterday" for yesterday')
  it.todo('formatRelativeTime MUST format as "Mon, Mar 10" for older dates')
})
