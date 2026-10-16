// Which membrane the Forge tab opens on — pure.

export interface MembraneMeta {
  id: string
  name: string
  workspaceIds: string[]
  color?: string
}

/**
 * The active membrane: the one the user picked in the tab (if it still
 * exists), else the active thread's membrane, else the first membrane that
 * holds the active workspace, else the first membrane with any workspace.
 */
export function pickMembrane(
  membranes: MembraneMeta[],
  ctx: { chosen?: string | null; threadMembrane?: string | null; workspaceId?: string | null }
): string | null {
  const has = (id: string | null | undefined): id is string => !!id && membranes.some((m) => m.id === id)
  if (has(ctx.chosen)) return ctx.chosen
  if (has(ctx.threadMembrane)) return ctx.threadMembrane
  if (ctx.workspaceId && ctx.workspaceId !== '_global') {
    const m = membranes.find((x) => x.workspaceIds.includes(ctx.workspaceId!))
    if (m) return m.id
  }
  return (membranes.find((m) => m.workspaceIds.length > 0) ?? membranes[0])?.id ?? null
}

/** Threads for the assign picker: the membrane's own first, then by recent activity. */
export function threadChoices<
  T extends { id: string; label: string; membraneId?: string; lastActivity?: number; archived?: boolean }
>(threads: T[], membrane: string): T[] {
  return threads
    .filter((t) => !t.archived)
    .sort(
      (a, b) =>
        Number(b.membraneId === membrane) - Number(a.membraneId === membrane) ||
        (b.lastActivity ?? 0) - (a.lastActivity ?? 0) ||
        (a.id < b.id ? -1 : 1)
    )
}
