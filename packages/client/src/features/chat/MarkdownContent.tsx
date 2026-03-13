export interface MarkdownContentProps {
  html: string
  class?: string
}

export function MarkdownContent(props: MarkdownContentProps) {
  return (
    <div
      class={`markdown-content prose prose-sm max-w-none ${props.class ?? ''}`}
      innerHTML={props.html}
      style={{
        '--tw-prose-headings': 'var(--c-text-heading)',
        '--tw-prose-links': 'var(--c-accent)',
        '--tw-prose-code': 'var(--c-text)'
      }}
    />
  )
}
