// The GraphQL queries the GitHub adapter sends. The wind tunnel's mock GitHub
// answers them by operation name, so keep the names stable.

const ACTOR = '... on Actor { login }'

/** Cross-references: the items that mention this one (first 20). */
const CROSS_REFS = `timelineItems(first: 20, itemTypes: [CROSS_REFERENCED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on Issue { number repository { nameWithOwner } }
              ... on PullRequest { number repository { nameWithOwner } }
            }
          }
        }
      }`

/** One page of pull requests, most recently updated first. */
export const CHANGES_QUERY = `query ForgeChanges($owner: String!, $name: String!, $first: Int!, $after: String, $states: [PullRequestState!]) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, after: $after, states: $states, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body url state isDraft merged
        createdAt updatedAt closedAt mergedAt
        author { ${ACTOR} }
        assignees(first: 20) { nodes { login } }
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Bot { login }
              ... on Mannequin { login }
              ... on Team { combinedSlug }
            }
          }
        }
        latestReviews(first: 20) { nodes { author { ${ACTOR} } state } }
        labels(first: 20) { nodes { name } }
        headRefName headRefOid baseRefName
        headRepository { nameWithOwner }
        mergeable
        closingIssuesReferences(first: 20) { nodes { number repository { nameWithOwner } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        ${CROSS_REFS}
      }
    }
  }
}`

/** One page of issues, most recently updated first; `since` filters server-side. */
export const ISSUES_QUERY = `query ForgeIssues($owner: String!, $name: String!, $first: Int!, $after: String, $states: [IssueState!], $since: DateTime) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after, states: $states, filterBy: { since: $since }, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body url state stateReason
        createdAt updatedAt closedAt
        author { ${ACTOR} }
        assignees(first: 20) { nodes { login } }
        labels(first: 20) { nodes { name } }
        ${CROSS_REFS}
      }
    }
  }
}`

/** One page of branches (refs/heads). */
export const BRANCHES_QUERY = `query ForgeBranches($owner: String!, $name: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name target { oid } }
    }
  }
}`
