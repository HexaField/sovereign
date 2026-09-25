/**
 * What a `file.changed` WS message means for the file open in the panel.
 * Deleting or moving a parent directory removes the open file too: some
 * watchers report only the directory, so a parent path counts as a hit.
 */
export function activeFileEffect(
  active: string | null,
  changedPath: string,
  kind: string | undefined
): 'clear' | 'reload' | null {
  if (!active) return null
  if (changedPath === active) return kind === 'deleted' ? 'clear' : 'reload'
  if (kind === 'deleted' && active.startsWith(changedPath.replace(/\/+$/, '') + '/')) return 'clear'
  return null
}
