// "The parent has 2 new revisions": under an editor's actions, full and side panel alike. It
// reads the status again when the window regains focus and whenever the entry's head moves.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { lazy, Suspense, useEffect, useRef } from "react"
import { Button } from "../../ui/Button.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { useOpenPlace } from "../editor/durable.tsx"
import { type EditorStore, useEditorState } from "../editor/store.ts"
import { kindWord, linkedByHand, revisionsLine, sourceOf, statusQuery } from "./status.ts"

const MergeDialog = lazy(() => import("./MergeDialog.tsx").then((m) => ({ default: m.MergeDialog })))

export function MergeNotice({ store }: { store: EditorStore }) {
  const snapshot = useEditorState(store).snapshot
  const ref = snapshot?.ref
  // An entry with no revision of its own yet (a card source's card before it's added) has nothing to merge.
  return ref && snapshot.revisionNumber > 0 ? (
    <Notice key={ref.id} store={store} refId={ref.id} head={ref.headRevisionId} kind={ref.kind} />
  ) : null
}

function Notice({
  store,
  refId,
  head,
  kind
}: {
  store: EditorStore
  refId: Parameters<typeof statusQuery>[0]
  head: string
  kind: string
}) {
  const atom = statusQuery(refId)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  // URL state, so a reload opens the review again; its choices are a durable draft.
  const [open, setOpen] = useOpenPlace(`merge-review:${refId}`)
  useEffect(() => {
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [refresh])
  // A save, restore, import or merge moves the head: what's new since the base can change with it.
  const seenHead = useRef(head)
  useEffect(() => {
    if (seenHead.current === head) return
    seenHead.current = head
    refresh()
  }, [head, refresh])
  if (AsyncResult.isFailure(result))
    return (
      <Alert
        tone="danger"
        title="Couldn't check for new revisions to merge"
        actions={
          <Button hint="Checks again for new revisions to merge." onClick={refresh}>
            Retry
          </Button>
        }
      />
    )
  if (!AsyncResult.isSuccess(result)) return null
  const status = result.value
  const count = status.versions.length
  if (count === 0) return null
  const fromFile = sourceOf(status) === "file"
  const title = fromFile
    ? `${count === 1 ? "A newer imported version is" : `${count} newer imported versions are`} waiting`
    : `The parent has ${revisionsLine(count)}`
  if (linkedByHand(status))
    return (
      <Alert title={title}>
        <p>
          This {kindWord(kind)} was marked as a fork by hand, so there's no shared starting revision to compare its
          changes with.
        </p>
      </Alert>
    )
  return (
    <>
      <Alert
        title={title}
        actions={
          <Button
            aria-pressed={open}
            hint={
              fromFile
                ? `Shows the file's changes to pick which to take into this ${kindWord(kind)}.`
                : `Shows the parent's changes to pick which to take into this ${kindWord(kind)}.`
            }
            onClick={() => setOpen(true)}
          >
            Review and merge
          </Button>
        }
      >
        <p>
          {fromFile ? "Its changes aren't" : "They aren't"} in this {kindWord(kind)} until you merge them.
        </p>
      </Alert>
      {open && (
        <Suspense fallback={null}>
          <MergeDialog refId={refId} store={store} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
