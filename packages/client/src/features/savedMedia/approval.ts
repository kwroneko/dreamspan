// Asking which new sites a saved entry may download its media from (spec/SAVED-MEDIA.md §3.2).
// Imports and card sources call `askMediaApproval`; the dialog (SavedMediaHost.tsx) opens only
// when the entries name sites the user hasn't decided about.
import type { RefId } from "@dreamspan/shared/library.ts"

/** These entries' media, or (null) every file of the account waiting for approval. */
type ApprovalRequest = { readonly refIds: ReadonlyArray<RefId> | null }

let current: ApprovalRequest | null = null
const listeners = new Set<() => void>()

export const askMediaApproval = (refIds: ReadonlyArray<RefId> | null) => {
  if (refIds !== null && refIds.length === 0) return
  // Requests made while the dialog is open join it: one dialog for a batch of files.
  current =
    current === null
      ? { refIds }
      : current.refIds === null || refIds === null
        ? { refIds: null }
        : { refIds: [...new Set([...current.refIds, ...refIds])] }
  for (const listener of listeners) listener()
}

export const approvalRequest = () => current

export const closeApproval = () => {
  current = null
  for (const listener of listeners) listener()
}

export const subscribeApproval = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
