// One store per library entry on the page (owner, 2026-11-23: a field opened in its own tab is
// the same text and the same draft as the field in its editor, edits in one showing live in the
// other): an editor or a field's tab not bound to a chat takes the store of an editor already
// open on its entry (openEditors.ts, which every `useLeaveGuard` registers), else a new one.
// A card on a card source shown for reading only (readOnly.ts) has its own, which keeps nothing.
import { remoteOf } from "@dreamspan/shared/cardSources.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { useState } from "react"
import { useSession } from "../../session.ts"
import { useCaller } from "./caller.ts"
import { openEditorStore } from "./openEditors.ts"
import { EditorStore } from "./store.ts"

/** A card on a card source, not added yet: its full editor and field tabs are for reading. */
export const readOnlyRef = (refId: string) => remoteOf(refId) !== null

/** The store for `refId`: `supplied` (a chat's), an open editor's, or a new one. */
export function useSharedEditorStore(refId: RefId, supplied?: EditorStore) {
  const call = useCaller()
  const userId = useSession().user.id
  const [store] = useState(() => {
    if (supplied) return supplied
    const readOnly = readOnlyRef(refId)
    const open = openEditorStore(refId)
    if (open instanceof EditorStore && open.readOnly === readOnly) return open
    const own = new EditorStore(refId, userId, call)
    own.readOnly = readOnly
    return own
  })
  return store
}
