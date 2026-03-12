const iconMap: Record<string, string> = {
  ts: '🟦',
  tsx: '⚛️',
  js: '🟨',
  jsx: '⚛️',
  json: '📋',
  md: '📝',
  css: '🎨',
  html: '🌐',
  svg: '🖼️',
  png: '🖼️',
  jpg: '🖼️',
  gif: '🖼️',
  py: '🐍',
  rs: '🦀',
  go: '🐹',
  sh: '⚙️',
  yml: '⚙️',
  yaml: '⚙️',
  toml: '⚙️',
  lock: '🔒',
  env: '🔐',
  gitignore: '🚫',
  dockerfile: '🐳'
}

export function getFileIcon(filename: string): string {
  const lower = filename.toLowerCase()
  // Special filenames
  if (lower === 'dockerfile') return '🐳'
  if (lower === 'makefile') return '⚙️'
  if (lower === 'readme.md') return '📖'
  if (lower === 'package.json') return '📦'

  const ext = lower.split('.').pop() ?? ''
  return iconMap[ext] ?? '📄'
}

export function getDirectoryIcon(_name: string): string {
  return '📁'
}
