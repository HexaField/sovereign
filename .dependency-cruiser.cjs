// dependency-cruiser config — enforces the @sovereign DAG.
// Each `from` matches a package by path; `to` matches the packages it must
// NOT depend on (i.e. anything at a higher layer). pnpm install already
// rejects undeclared cross-package imports; this catches violations within
// the source tree before they ever reach package.json.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // Layer 0: primitives must not depend on any sovereign sibling
    {
      name: 'primitives-no-sovereign-deps',
      comment: 'primitives is the leaf; it may only depend on @sovereign/core (types).',
      severity: 'error',
      from: { path: '^packages/primitives/' },
      to: {
        path: '^packages/(?!primitives|core)/',
        pathNot: '^node_modules/'
      }
    },
    // Layer 1: core has no sovereign deps
    {
      name: 'core-no-sovereign-deps',
      comment: 'core is the protocol layer; it must not depend on any sovereign sibling.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^packages/(?!core)/' }
    },
    // Layer 2-3 (infrastructure): no upward deps
    {
      name: 'infrastructure-no-upward',
      comment: 'infra layer packages may only import from core, primitives, or other infra peers.',
      severity: 'error',
      from: {
        path: '^packages/(config|auth|orgs|files|git|terminal|worktrees|scheduler|notifications|browser)/'
      },
      to: {
        path: '^packages/(diff|issues|radicle|review|recordings|voice|threads|meetings|planning|drafts|agent-backend|chat|system)/',
        pathNot: '^node_modules/'
      }
    },
    // Layer 4 packages: no upward deps to layer 5+
    {
      name: 'domain-no-upward',
      comment: 'domain packages must not depend on composition (layer 5+) packages.',
      severity: 'error',
      from: {
        path: '^packages/(diff|issues|radicle|review|recordings|voice)/'
      },
      to: {
        path: '^packages/(threads|meetings|planning|drafts|agent-backend|chat|system)/',
        pathNot: '^node_modules/'
      }
    },
    // Layer 5 packages: no upward deps to layer 6+
    {
      name: 'composition-no-upward',
      comment: 'composition packages must not depend on chat or system.',
      severity: 'error',
      from: {
        path: '^packages/(threads|meetings|planning|drafts|agent-backend)/'
      },
      to: {
        path: '^packages/(chat|system)/',
        pathNot: '^node_modules/'
      }
    },
    // Layer 6: chat must not depend on system
    {
      name: 'chat-no-system-dep',
      comment: 'chat must not depend on system (system is layer 7, observes chat).',
      severity: 'error',
      from: { path: '^packages/chat/' },
      to: { path: '^packages/system/' }
    },
    // Scheduler must not depend on agent-backend (the original violation)
    {
      name: 'scheduler-no-agent-backend',
      comment: 'scheduler is below agent-backend; consume CronBridge/BackendRouter via @sovereign/core instead.',
      severity: 'error',
      from: { path: '^packages/scheduler/' },
      to: { path: '^packages/agent-backend/' }
    },
    // Threads must not import chat
    {
      name: 'threads-no-chat',
      comment: 'threads is below chat; chat consumes threads, not the other way around.',
      severity: 'error',
      from: { path: '^packages/threads/' },
      to: { path: '^packages/chat/' }
    },
    // Voice and recordings are peers — neither should import from the other
    {
      name: 'voice-no-recordings',
      comment: 'voice must not import from recordings; share types via @sovereign/core.',
      severity: 'error',
      from: { path: '^packages/voice/' },
      to: { path: '^packages/recordings/' }
    },
    // Drafts must not depend on planning (lateral)
    {
      name: 'drafts-no-planning',
      comment: 'drafts and planning are peers; share types via @sovereign/core (EntityRef).',
      severity: 'error',
      from: { path: '^packages/drafts/' },
      to: { path: '^packages/planning/' }
    },
    // No package should reach into another package's internals
    {
      name: 'no-internal-imports',
      comment: 'Cross-package imports must go through the package root (e.g. @sovereign/orgs), not internal paths.',
      severity: 'error',
      from: { path: '^packages/' },
      to: {
        path: '^@sovereign/[^/]+/src/',
        pathNot: '^@sovereign/[^/]+/(cli)$'
      }
    },
    // No orphan modules
    {
      name: 'no-orphans',
      comment: 'Every source file should be reachable from a package entry point.',
      severity: 'warn',
      from: { orphan: true, pathNot: '\\.(d\\.ts|test\\.ts|spec\\.ts|config\\.[jt]s)$' },
      to: {}
    },
    // No circular dependencies
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular package dependencies break tree-shaking and force-feed weird module loading orders.',
      from: {},
      to: { circular: true }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(dist|\\.test\\.ts$|^packages/client/)' },
    tsConfig: { fileName: './tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'development', 'import', 'require', 'node', 'default']
    },
    reporterOptions: {
      text: { highlightFocused: true }
    }
  }
}
