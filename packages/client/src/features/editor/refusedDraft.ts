import type { Draft, DraftDisplacement } from "@dreamspan/shared/drafts.ts"

// The server keeps the history. The tab remembers which snapshot it can offer back
// after a reload, scoped to that active drafting session.
type Refusal = { draftId: string; session: number; refused: DraftDisplacement }

export const readRefusedDraft = (key: string, draft: Draft | null): DraftDisplacement | null => {
  if (draft?.status !== "active") return null
  try {
    const entry: Refusal | null = JSON.parse(sessionStorage.getItem(key) ?? "null")
    if (
      entry?.draftId === draft.id &&
      entry.session === draft.session &&
      typeof entry.refused?.at === "number" &&
      typeof entry.refused.content === "string"
    )
      return entry.refused
  } catch {
    // The in-memory offer and server history still work without browser storage.
  }
  return null
}

export const keepRefusedDraft = (key: string, draft: Draft, refused: DraftDisplacement) => {
  try {
    sessionStorage.setItem(key, JSON.stringify({ draftId: draft.id, session: draft.session, refused }))
  } catch {
    // The in-memory offer and server history still work without browser storage.
  }
}

export const clearRefusedDraft = (key: string) => {
  try {
    sessionStorage.removeItem(key)
  } catch {
    // Storage may be unavailable.
  }
}
