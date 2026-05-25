// Default module registry — declares every well-known Sovereign module to
// the system module so health/architecture endpoints know the full topology.
// Kept here so the entry point doesn't carry a long flat list of metadata.

import type { SystemModule } from './system.js'

export function registerDefaultModules(system: SystemModule): void {
  system.registerModule({
    name: 'scheduler',
    status: 'healthy',
    subscribes: ['scheduler.job.*'],
    publishes: ['scheduler.job.due', 'scheduler.job.started', 'scheduler.job.completed']
  })
  system.registerModule({
    name: 'orgs',
    status: 'healthy',
    subscribes: [],
    publishes: ['org.created', 'org.updated', 'org.deleted']
  })
  system.registerModule({
    name: 'files',
    status: 'healthy',
    subscribes: [],
    publishes: ['file.created', 'file.deleted']
  })
  system.registerModule({ name: 'git', status: 'healthy', subscribes: [], publishes: ['git.status.changed'] })
  system.registerModule({
    name: 'terminal',
    status: 'healthy',
    subscribes: [],
    publishes: ['terminal.created', 'terminal.closed']
  })
  system.registerModule({
    name: 'worktrees',
    status: 'healthy',
    subscribes: [],
    publishes: ['worktree.created', 'worktree.removed']
  })
  system.registerModule({
    name: 'config',
    status: 'healthy',
    subscribes: ['config.changed'],
    publishes: ['config.changed']
  })
  system.registerModule({
    name: 'diff',
    status: 'healthy',
    subscribes: [],
    publishes: ['changeset.created', 'changeset.updated']
  })
  system.registerModule({
    name: 'issues',
    status: 'healthy',
    subscribes: [],
    publishes: ['issue.created', 'issue.updated']
  })
  system.registerModule({
    name: 'review',
    status: 'healthy',
    subscribes: [],
    publishes: ['review.created', 'review.updated', 'review.merged']
  })
  system.registerModule({
    name: 'radicle',
    status: 'healthy',
    subscribes: [],
    publishes: ['radicle.repo.init', 'radicle.peer.connected']
  })
  system.registerModule({
    name: 'planning',
    status: 'healthy',
    subscribes: ['issue.*'],
    publishes: ['planning.graph.updated']
  })
  system.registerModule({ name: 'chat', status: 'healthy', subscribes: [], publishes: [] })
  system.registerModule({ name: 'threads', status: 'healthy', subscribes: [], publishes: [] })
  system.registerModule({ name: 'voice', status: 'healthy', subscribes: [], publishes: [] })
  system.registerModule({
    name: 'recordings',
    status: 'healthy',
    subscribes: [],
    publishes: ['recording.created', 'recording.transcribed']
  })
  system.registerModule({
    name: 'meetings',
    status: 'healthy',
    subscribes: ['recording.transcribed'],
    publishes: ['meeting.created', 'meeting.updated', 'meeting.summarized', 'meeting.deleted']
  })
  system.registerModule({
    name: 'notifications',
    status: 'healthy',
    subscribes: ['notification.*'],
    publishes: ['notification.new']
  })
}
