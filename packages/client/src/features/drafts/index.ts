// Singleton drafts store instance
import { createDraftsStore } from './store.js'

export const draftsStore = createDraftsStore()
export type { Draft, DraftDep, DraftDepTarget, UpdateDraft, EntityRef } from './store.js'
