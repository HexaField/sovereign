import { Component, createResource, Show, For, createMemo } from 'solid-js'

export interface EntityComment {
  id: string
  author: string
  body: string
  createdAt: string
}

export interface EntityData {
  id: string
  type: 'issue' | 'pr' | 'patch'
  title: string
  status: string
  author: string
  body: string
  labels: string[]
  comments: EntityComment[]
  linkedThreads: string[]
}

export interface EntityDetailTabProps {
  entityId: string
  entityType: 'issue' | 'pr' | 'patch'
  projectId: string
  onClose?: () => void
  onOpenThread?: (threadKey: string) => void
}

async function fetchEntity(params: { entityId: string; entityType: string; projectId: string }): Promise<EntityData> {
  const res = await fetch(
    `/api/${params.entityType === 'issue' ? 'issues' : 'pulls'}/${params.entityId}?project=${encodeURIComponent(params.projectId)}`
  )
  if (!res.ok) throw new Error(`Failed to fetch entity: ${res.statusText}`)
  return res.json()
}

const statusColors: Record<string, string> = {
  open: 'var(--c-success, #22c55e)',
  closed: 'var(--c-error, #ef4444)',
  merged: 'var(--c-info, #8b5cf6)',
  draft: 'var(--c-text-muted)'
}

const EntityDetailTab: Component<EntityDetailTabProps> = (props) => {
  const [data] = createResource(
    () => ({ entityId: props.entityId, entityType: props.entityType, projectId: props.projectId }),
    fetchEntity
  )

  const typeLabel = createMemo(() => {
    const t = props.entityType
    return t === 'issue' ? 'Issue' : t === 'pr' ? 'Pull Request' : 'Patch'
  })

  return (
    <div class="flex h-full flex-col overflow-hidden" style={{ background: 'var(--c-bg-primary)' }}>
      {/* Header */}
      <div
        class="flex shrink-0 items-center justify-between border-b px-3 py-1.5 text-sm"
        style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text-secondary)' }}
      >
        <div class="flex items-center gap-2">
          <span></span>
          <span style={{ color: 'var(--c-text-primary)' }}>{data()?.title ?? `${typeLabel()} #${props.entityId}`}</span>
        </div>
        <Show when={props.onClose}>
          <button
            class="text-lg leading-none hover:opacity-80"
            style={{ color: 'var(--c-text-muted)' }}
            onClick={props.onClose}
            aria-label="Close tab"
          >
            ×
          </button>
        </Show>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-auto p-4">
        <Show when={data.loading}>
          <div class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
            Loading…
          </div>
        </Show>
        <Show when={data.error}>
          <div class="text-sm" style={{ color: 'var(--c-error)' }}>
            Error: {(data.error as Error).message}
          </div>
        </Show>
        <Show when={data()}>
          {(entity) => (
            <div class="flex flex-col gap-4">
              {/* Title + meta */}
              <div>
                <h2 class="m-0 text-lg font-semibold" style={{ color: 'var(--c-text-primary)' }}>
                  {entity().title}
                </h2>
                <div class="mt-1 flex items-center gap-3 text-sm">
                  <span
                    class="rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{
                      background: statusColors[entity().status] ?? 'var(--c-bg-tertiary)',
                      color: 'white'
                    }}
                  >
                    {entity().status}
                  </span>
                  <span style={{ color: 'var(--c-text-muted)' }}>by {entity().author}</span>
                </div>
              </div>

              {/* Labels */}
              <Show when={entity().labels.length > 0}>
                <div class="flex flex-wrap gap-1">
                  <For each={entity().labels}>
                    {(label) => (
                      <span
                        class="rounded-full px-2 py-0.5 text-xs"
                        style={{ background: 'var(--c-bg-tertiary)', color: 'var(--c-text-secondary)' }}
                      >
                        {label}
                      </span>
                    )}
                  </For>
                </div>
              </Show>

              {/* Body (markdown rendered as plain text for now) */}
              <div class="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--c-text-primary)' }}>
                {entity().body}
              </div>

              {/* Open Thread button */}
              <Show when={props.onOpenThread}>
                <button
                  class="self-start rounded px-3 py-1.5 text-sm"
                  style={{
                    background: 'var(--c-accent)',
                    color: 'var(--c-text-on-accent, white)'
                  }}
                  onClick={() => props.onOpenThread?.(`${props.entityType}:${props.entityId}`)}
                >
                  Open Thread
                </button>
              </Show>

              {/* Comments */}
              <Show when={entity().comments.length > 0}>
                <div class="border-t pt-3" style={{ 'border-color': 'var(--c-border)' }}>
                  <h3 class="mb-2 text-sm font-medium" style={{ color: 'var(--c-text-secondary)' }}>
                    Comments ({entity().comments.length})
                  </h3>
                  <div class="flex flex-col gap-3">
                    <For each={entity().comments}>
                      {(comment) => (
                        <div class="rounded p-3 text-sm" style={{ background: 'var(--c-bg-secondary)' }}>
                          <div class="mb-1 flex items-center gap-2">
                            <span class="font-medium" style={{ color: 'var(--c-text-primary)' }}>
                              {comment.author}
                            </span>
                            <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                              {new Date(comment.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <div class="whitespace-pre-wrap" style={{ color: 'var(--c-text-primary)' }}>
                            {comment.body}
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

export default EntityDetailTab
export { fetchEntity }
