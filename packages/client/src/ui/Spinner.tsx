export function Spinner() {
  return (
    <div
      class="inline-block h-5 w-5 rounded-full border-2 border-current border-t-transparent"
      style={{
        color: 'var(--c-accent)',
        animation: 'spin 0.6s linear infinite'
      }}
      role="status"
      aria-label="Loading"
    />
  )
}
