import { Component, createResource, Show, For } from 'solid-js'
import { marked } from 'marked'
import { closePlanningView } from '../store.js'

export interface IssueDetailData {
  id: string
  projectId: string
  orgId: string
  title: string
  state: 'open' | 'closed'
  labels: string[]
  assignees: string[]
  author: string
  body: string
  createdAt: string
  updatedAt: string
  providerUrl?: string
  commentCount: number
}

export interface IssueComment {
  id: string
  author: string
  body: string
  createdAt: string
}

export interface IssueDetailViewProps {
  orgId: string
  projectId: string
  issueId: string
}

export function buildIssueDetailUrl(orgId: string, projectId: string, issueId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}`
}

export function buildCommentsUrl(orgId: string, projectId: string, issueId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/comments`
}

async function fetchIssueDetail(params: {
  orgId: string
  projectId: string
  issueId: string
}): Promise<{ issue: IssueDetailData; comments: IssueComment[] }> {
  const [issueRes, commentsRes] = await Promise.all([
    fetch(buildIssueDetailUrl(params.orgId, params.projectId, params.issueId)),
    fetch(buildCommentsUrl(params.orgId, params.projectId, params.issueId))
  ])

  if (!issueRes.ok) throw new Error(`Failed to fetch issue: ${issueRes.statusText}`)
  const issue = await issueRes.json()
  const comments = commentsRes.ok ? await commentsRes.json() : []
  return { issue, comments }
}

function renderMarkdown(md: string): string {
  try {
    return marked.parse(md, { async: false }) as string
  } catch {
    return md
  }
}

const stateColors: Record<string, string> = {
  open: 'var(--c-success, #22c55e)',
  closed: 'var(--c-error, #ef4444)'
}

const IssueDetailView: Component<IssueDetailViewProps> = (props) => {
  const [data] = createResource(
    () => ({ orgId: props.orgId, projectId: props.projectId, issueId: props.issueId }),
    fetchIssueDetail
  )

  return (
    <div class="flex h-full flex-col overflow-hidden" style={{ background: 'var(--c-bg)' }}>
      {/* Header */}
      <div
        class="flex shrink-0 items-center justify-between border-b px-3 py-1.5"
        style={{ 'border-color': 'var(--c-border)' }}
      >
        <div class="flex items-center gap-2">
          <button
            class="rounded px-2 py-0.5 text-xs transition-colors hover:opacity-80"
            style={{ background: 'var(--c-bg-secondary)', color: 'var(--c-text-muted)' }}
            onClick={() => closePlanningView()}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M7.5 2L3.5 6L7.5 10" />
            </svg>
          </button>
          <span class="text-sm" style={{ color: 'var(--c-text-heading)' }}>
            {data()?.issue.title ?? 'Issue Detail'}
          </span>
        </div>
        <button
          class="text-lg leading-none hover:opacity-80"
          style={{ color: 'var(--c-text-muted)' }}
          onClick={() => closePlanningView()}
          aria-label="Close"
        >
          x
        </button>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-auto p-4">
        <Show when={data.loading}>
          <p class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
            Loading...
          </p>
        </Show>
        <Show when={data.error}>
          <p class="text-sm" style={{ color: 'var(--c-error)' }}>
            Error: {(data.error as Error).message}
          </p>
        </Show>
        <Show when={data()}>
          {(d) => {
            const issue = () => d().issue
            const comments = () => d().comments
            return (
              <div class="flex flex-col gap-4">
                {/* Title and state */}
                <div>
                  <h2 class="m-0 text-lg font-semibold" style={{ color: 'var(--c-text)' }}>
                    {issue().title}
                  </h2>
                  <div class="mt-1 flex items-center gap-3 text-sm">
                    <span
                      class="rounded-full px-2 py-0.5 text-xs font-medium"
                      style={{
                        background: stateColors[issue().state] ?? 'var(--c-bg-tertiary)',
                        color: 'white'
                      }}
                    >
                      {issue().state}
                    </span>
                    <span style={{ color: 'var(--c-text-muted)' }}>by {issue().author}</span>
                    <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                      {new Date(issue().createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>

                {/* Labels */}
                <Show when={issue().labels.length > 0}>
                  <div class="flex flex-wrap gap-1">
                    <For each={issue().labels}>
                      {(label) => (
                        <span
                          class="rounded-full px-2 py-0.5 text-xs"
                          style={{ background: 'var(--c-bg-tertiary)', color: 'var(--c-text-muted)' }}
                        >
                          {label}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>

                {/* Assignees */}
                <Show when={issue().assignees.length > 0}>
                  <div class="flex items-center gap-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                    <span>Assigned to:</span>
                    {issue().assignees.join(', ')}
                  </div>
                </Show>

                {/* Provider link */}
                <Show when={issue().providerUrl}>
                  <a
                    href={issue().providerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-xs underline"
                    style={{ color: 'var(--c-accent)' }}
                  >
                    View on provider
                  </a>
                </Show>

                {/* Body */}
                <div
                  class="prose prose-sm max-w-none text-sm leading-relaxed"
                  style={{ color: 'var(--c-text)' }}
                  innerHTML={renderMarkdown(issue().body || '')}
                />

                {/* Comments */}
                <Show when={comments().length > 0}>
                  <div class="border-t pt-3" style={{ 'border-color': 'var(--c-border)' }}>
                    <h3 class="mb-2 text-sm font-medium" style={{ color: 'var(--c-text-muted)' }}>
                      Comments ({comments().length})
                    </h3>
                    <div class="flex flex-col gap-3">
                      <For each={comments()}>
                        {(comment) => (
                          <div class="rounded p-3 text-sm" style={{ background: 'var(--c-bg-secondary)' }}>
                            <div class="mb-1 flex items-center gap-2">
                              <span class="font-medium" style={{ color: 'var(--c-text)' }}>
                                {comment.author}
                              </span>
                              <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                                {new Date(comment.createdAt).toLocaleString()}
                              </span>
                            </div>
                            <div
                              class="prose prose-sm max-w-none"
                              style={{ color: 'var(--c-text)' }}
                              innerHTML={renderMarkdown(comment.body)}
                            />
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
            )
          }}
        </Show>
      </div>
    </div>
  )
}

export default IssueDetailView
