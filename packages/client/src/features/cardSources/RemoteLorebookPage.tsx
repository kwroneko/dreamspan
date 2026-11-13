// A standalone lorebook on a card source (spec/CARD-SOURCES.md §3.9): opening it adds it. This
// page adds it to the user's lorebooks (or finds the one they have from there) and replaces
// itself with the lorebook editor, so a click, a link and a new browser tab all end there.
import { Link, useNavigate, useParams } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { EmptyState } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useTitle } from "../shell.tsx"
import { useSourceList } from "./browse.tsx"
import { lorebookProblem, useAdoptRemoteLorebook, useSourceCall } from "./remote.ts"

export function RemoteLorebookPage() {
  const { sourceId = "", remoteId = "" } = useParams({ strict: false }) as { sourceId?: string; remoteId?: string }
  const list = useSourceList()
  const info = list?.find((s) => s.id === sourceId && s.enabled)
  const name = info?.name ?? sourceId
  const adopt = useAdoptRemoteLorebook()
  const call = useSourceCall()
  const navigate = useNavigate()
  const [failed, setFailed] = useState<{ attempt: number; text: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const problem = failed?.attempt === attempt ? failed.text : null
  useTitle("Lorebook")
  useEffect(() => {
    if (!info) return
    let live = true
    void call((client) => client("SourceCard", { sourceId, remoteId }))
      .then(async (viewed) => {
        if (!live || viewed === null) return null
        if (!viewed.ok) return viewed
        return adopt(sourceId, name, remoteId, true)
      })
      .then((out) => {
        if (!live || out === null) return
        if (!out.ok) return setFailed({ attempt, text: lorebookProblem(name, out.problem) })
        void navigate({ to: "/library/$refId", params: { refId: out.value.refId }, replace: true })
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `adopt` and `navigate` are fresh closures each render
  }, [sourceId, remoteId, attempt, info === undefined])
  if (list === null) return <p className="p-2 text-sm text-muted">Loading…</p>
  if (!info)
    return (
      <EmptyState title={`${name} is turned off in Settings`}>
        <Tooltip label="Opens the card sources settings.">
          <Link to="/settings/card-sources" className="text-accent">
            Card sources settings
          </Link>
        </Tooltip>
      </EmptyState>
    )
  if (problem)
    return (
      <EmptyState title={problem}>
        <Button hint={`Asks ${name} for the lorebook again.`} onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </Button>
      </EmptyState>
    )
  return (
    <p data-remote-lorebook-page className="p-2 text-sm text-muted">
      Adding the lorebook from {name}…
    </p>
  )
}
