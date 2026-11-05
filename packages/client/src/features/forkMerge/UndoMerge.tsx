// History's "Undo merge" on a merge revision: only while that merge is the latest revision and
// nothing is unsaved. It adds a revision with the content from before the merge and offers the
// merged revisions again; after later edits, Restore brings back earlier content instead.
import { useAtomValue } from "@effect/atom-react"
import type { Revision } from "@rp/shared/library.ts"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { useCaller } from "../editor/caller.ts"
import { type EditorStore, useEditorState, useHeld } from "../editor/store.ts"
import { statusQuery } from "./status.ts"

export function UndoMerge({ store, revision }: { store: EditorStore; revision: Revision }) {
  return revision.origin === "merge" ? <UndoMergeButton store={store} revision={revision} /> : null
}

function UndoMergeButton({ store, revision }: { store: EditorStore; revision: Revision }) {
  const state = useEditorState(store)
  const held = useHeld(store)
  const ref = state.snapshot!.ref
  const result = useAtomValue(statusQuery(ref.id))
  const call = useCaller()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const record = AsyncResult.isSuccess(result)
    ? result.value.records.find((r) => r.revisionId === revision.id)
    : undefined
  if (!record) return null
  const why =
    record.undoneByRevisionId !== null
      ? "This merge was already undone."
      : ref.headRevisionId !== revision.id
        ? "Only the latest revision's merge can be undone; restore an earlier revision instead."
        : state.dirty > 0 || held !== ""
          ? "Save or revert the unsaved changes first."
          : null
  const undo = async () => {
    setPending(true)
    setError(null)
    const outcome = await call(
      (client) =>
        client("UndoForkMerge", { refId: ref.id, mergeRevisionId: revision.id, expectedRowVersion: ref.rowVersion }),
      ["library"]
    )
    setPending(false)
    if (!outcome.ok) return setError(outcome.error)
    await store.refresh()
  }
  return (
    <>
      <Button
        className="h-8 px-2"
        pending={pending}
        disabled={why !== null}
        focusableWhenDisabled
        hint={why ?? "Puts back the content from before this merge and offers its changes again."}
        onClick={() => void undo()}
      >
        Undo merge
      </Button>
      {error && (
        <p role="alert" className="w-full text-sm text-danger">
          {error.message}
        </p>
      )}
    </>
  )
}
