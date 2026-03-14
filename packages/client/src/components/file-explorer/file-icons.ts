const iconMap: Record<string, string> = {
  ts: 'TS',
  tsx: 'TX',
  js: 'JS',
  jsx: 'JX',
  json: '{}',
  md: 'MD',
  css: 'CS',
  html: '<>',
  svg: 'SV',
  png: 'IM',
  jpg: 'IM',
  gif: 'IM',
  py: 'PY',
  rs: 'RS',
  go: 'GO',
  sh: 'SH',
  yml: 'YM',
  yaml: 'YM',
  toml: 'TM',
  lock: 'LK',
  env: 'EN',
  gitignore: 'GI',
  dockerfile: 'DK'
}

export function getFileIcon(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower === 'dockerfile') return 'DK'
  if (lower === 'makefile') return 'MK'
  if (lower === 'readme.md') return 'RM'
  if (lower === 'package.json') return 'PK'

  const ext = lower.split('.').pop() ?? ''
  return iconMap[ext] ?? '--'
}

export function getDirectoryIcon(_name: string): string {
  return 'DIR'
}
