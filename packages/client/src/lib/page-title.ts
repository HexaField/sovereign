/** Browser tab title: the active thread's name first, so open tabs tell threads apart. */
export function pageTitle(threadLabel?: string | null): string {
  const label = threadLabel?.trim()
  return label ? `${label} · Sovereign` : 'Sovereign'
}
