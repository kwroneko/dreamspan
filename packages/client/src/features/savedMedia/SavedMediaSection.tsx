// An entry's Saved media section (spec/SAVED-MEDIA.md §3.5), in the card, preset and lorebook
// editors: how many of its current revision's media files are kept here, which wait for the
// user's approval, and which couldn't be saved and why.
import type { SavedMediaStatus } from "@dreamspan/shared/savedMedia.ts"
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Card, CardHeader, Disclosure } from "../../ui/Surface.tsx"
import { savedMedia } from "../../ui/html/savedMedia.ts"
import { useCaller } from "../editor/caller.ts"
import { type EditorStore, useEditorState } from "../editor/store.ts"
import { askMediaApproval, subscribeApproval } from "./approval.ts"

const files = (n: number) => `${n} media ${n === 1 ? "file" : "files"}`

export function SavedMediaSection({ store }: { store: EditorStore }) {
  const call = useCaller()
  const { snapshot } = useEditorState(store)
  const head = snapshot?.ref.headRevisionId ?? null
  const [status, setStatus] = useState<SavedMediaStatus | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [tick, setTick] = useState(0)
  const [seenHead, setSeenHead] = useState(head)
  if (seenHead !== head) {
    setSeenHead(head)
    setTick(0)
  }

  // A dialog closing may have approved some of this entry's sites.
  useEffect(() => subscribeApproval(() => setTick((n) => n + 1)), [])
  useEffect(() => {
    if (head === null) return
    let active = true
    void call((client) => client("GetSavedMediaStatus", { refId: store.refId })).then((result) => {
      if (!active) return
      if (result.ok) setStatus(result.value)
      else setError(result.error)
    })
    return () => {
      active = false
    }
  }, [call, store.refId, head, tick])
  // Downloading: ask again shortly, and once more after a save (its files are listed in the background).
  const waiting = status?.waiting ?? 0
  useEffect(() => {
    if (head === null || (status !== null && waiting === 0 && tick > 0)) return
    const timer = setTimeout(() => {
      setTick((n) => n + 1)
      if (waiting > 0) savedMedia.forget()
    }, 3000)
    return () => clearTimeout(timer)
  }, [head, waiting, status, tick])

  if (status === null) return error ? <ErrorAlert error={error} /> : null
  const failed = status.failed.length
  if (status.saved + status.waiting + status.approval + status.declined + failed === 0) return null
  const retry = async () => {
    setRetrying(true)
    const result = await call((client) => client("RetrySavedMedia", { refId: store.refId }))
    setRetrying(false)
    if (result.ok) {
      setStatus(result.value)
      savedMedia.forget()
    } else setError(result.error)
  }
  return (
    <Card>
      <CardHeader
        title="Saved media"
        about="Images, sounds and fonts this entry loads from other sites are saved here, so showing it never contacts those sites. The entry's text stays as it is."
        description={`${files(status.saved)} saved here`}
      />
      <div className="flex flex-col gap-3 text-sm">
        <ErrorAlert error={error} />
        {status.waiting > 0 && <p>{files(status.waiting)} downloading.</p>}
        {status.approval > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <p>{files(status.approval)} on sites you haven't approved.</p>
            <Button
              hint="Choose which of these sites this app may download from."
              onClick={() => askMediaApproval([store.refId])}
            >
              Review
            </Button>
          </div>
        )}
        {status.declined > 0 && <p>{files(status.declined)} not downloaded, as you chose.</p>}
        {failed > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <p>{failed === 1 ? "1 couldn't be saved." : `${failed} couldn't be saved.`}</p>
              <Button
                hint="Downloads them again, from approved sites only."
                pending={retrying}
                onClick={() => void retry()}
              >
                Try again
              </Button>
            </div>
            <Disclosure title="Show which, and why">
              <ul className="flex flex-col gap-2">
                {status.failed.map((entry) => (
                  <li key={entry.url} className="flex min-w-0 flex-col">
                    <span className="font-mono text-xs [overflow-wrap:anywhere]">{entry.url}</span>
                    <span className="text-muted">{entry.reason}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          </div>
        )}
      </div>
    </Card>
  )
}
