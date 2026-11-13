// Browser copies include other tabs' debounced editor text. The writer separately checks
// server drafts in its transaction, so an acknowledged copy is protected there instead.
import { copiesOfUser, pendingOf } from "./backup.ts"
import { unsavedEditorRefs } from "./openEditors.ts"

export const pendingLibraryRefs = async (userId: string) =>
  new Set([
    ...unsavedEditorRefs(),
    ...(await copiesOfUser(userId)).flatMap((copy) => {
      const save = pendingOf(copy)
      return save?.kind === "editor" ? [save.payload.refId] : []
    })
  ])
