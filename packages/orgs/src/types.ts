// Org & Project types

export interface Org {
  id: string
  name: string
  path: string
  provider?: 'radicle' | 'github'
  createdAt: string
  updatedAt: string
}

export interface Project {
  id: string
  orgId: string
  name: string
  repoPath: string
  remote?: string
  defaultBranch: string
  monorepo?: {
    tool: 'pnpm' | 'npm' | 'nx' | 'turborepo'
    packages: string[]
  }
  createdAt: string
  updatedAt: string
}
