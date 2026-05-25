// Backwards-compat re-export. Canonical session-key derivation lives in
// @sovereign/core so threads / agent-backend / chat can all share it without
// depending on this module.

export { deriveSessionKey } from '@sovereign/core'
