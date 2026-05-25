// Cross-domain shared types

/**
 * Stable reference to an entity (issue/PR) inside a project.
 * Used across planning, drafts, and any module that links to issues.
 */
export interface EntityRef {
  orgId: string
  projectId: string
  remote: string
  issueId: string
}
