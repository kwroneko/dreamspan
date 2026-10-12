// One message: who wrote it, its versions (swipe through them, or generate another), its
// text, and what can be done with it. Rows only re-render when their slot changes; the
// text of a generating version comes from its own atom, so a token re-renders the body.
import { useAtomValue } from "@effect/atom-react"
import type { PathEntry, SlotId, Version } from "@rp/shared/chat.ts"
import { Link } from "@tanstack/react-router"
import { memo, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Textarea } from "../../ui/Field.tsx"
import { Markdown } from "../../ui/Markdown.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { castView, nameOf, useCast } from "./cast.ts"
import { displayText } from "./macros.ts"
import { useMountedTracking, useRenderCount } from "./perf.ts"
import { type ChatSession, liveText, type Outcome } from "./session.ts"

/** A horizontal drag this long on a message swipes to the next or previous version. */
const SWIPE_PX = 60

/** Statuses shown as a badge; `complete` needs none. */
const flagged = new Set<Version["status"]>(["generating", "stopped", "interrupted", "failed"])

/**
 * Text whose macros resolve against the chat's state at its position (DESIGN §5.6): a
 * greeting's `{{user}}` is whoever the user played before it, so it follows a persona
 * change until a message is sent after it, and a later change doesn't rewrite it. Only
 * such text reads the cast there; other messages render as before.
 */
function TemplateText({
  version,
  session,
  parentSlotId
}: {
  version: Version
  session: ChatSession
  parentSlotId: SlotId | null
}) {
  const cast = useCast()
  const read = useCallback(() => session.castAfter(parentSlotId), [session, parentSlotId])
  const positionCast = useSyncExternalStore(session.subscribePositions, read)
  // The speaker card's own fields, for `{{description}}` and the like, as the preview had them.
  const readFields = useCallback(
    () => (version.speakerEntityId === null ? undefined : session.cardFields(version.speakerEntityId)),
    [session, version.speakerEntityId]
  )
  const fields = useSyncExternalStore(session.subscribePositions, readFields)
  const here = useMemo(
    () => (positionCast ? castView(positionCast, [...cast.cards.values()]) : cast),
    [positionCast, cast]
  )
  // Random and time macros show what they drew when the greeting was first shown.
  const text = displayText(
    version.content,
    version.macroMode,
    { user: here.user, char: nameOf(here, version.speakerEntityId) ?? here.char },
    fields ?? {},
    version.frozenMacros ?? {}
  )
  return <Markdown text={text} streaming={false} />
}

function VersionBody({
  version,
  session,
  parentSlotId
}: {
  version: Version
  session: ChatSession
  parentSlotId: SlotId | null
}) {
  const live = useAtomValue(liveText(version.id))
  useRenderCount("bodyRenders", live !== null ? "liveBodyRenders" : undefined)
  useMountedTracking(version.id)
  const generating = version.status === "generating"
  const text = live ?? version.content
  return (
    <div className="flex flex-col gap-2">
      {text === "" && generating ? (
        <p className="text-sm text-muted" aria-live="polite">
          Writing…
        </p>
      ) : live === null && version.macroMode === "template" ? (
        <TemplateText version={version} session={session} parentSlotId={parentSlotId} />
      ) : (
        <Markdown text={text} streaming={generating} />
      )}
      {version.status === "failed" && version.error && (
        <p role="note" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          Failed ({version.error.class}): {version.error.message}
        </p>
      )}
    </div>
  )
}

function Editor({
  initial,
  onSave,
  onCancel
}: {
  initial: string
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(text)
      }}
    >
      <Textarea aria-label="Message text" value={text} onChange={(event) => setText(event.currentTarget.value)} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary">
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

export const Message = memo(function Message({
  entry,
  session,
  highlighted,
  branchLeaf
}: {
  entry: PathEntry
  session: ChatSession
  highlighted: boolean
  /** The leaf of the branch shown, when it isn't the chat's active one: links keep to it. */
  branchLeaf: SlotId | null
}) {
  useRenderCount("rowRenders")
  const cast = useCast()
  const { version } = entry
  const [versions, setVersions] = useState<ReadonlyArray<Version> | null>(null)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const swipeStart = useRef<{ x: number; y: number } | null>(null)
  const model = version.writer === "model"
  const generating = version.status === "generating"

  // A slot that gained or lost versions needs its list read again.
  // The list as read is current while it has as many versions as the slot, this one among them.
  const position =
    versions !== null && versions.length === entry.versionCount ? versions.findIndex((v) => v.id === version.id) : -1
  const known = position >= 0

  const report = (outcome: Outcome<unknown>) => setError(outcome.ok ? null : outcome.error)

  const loadVersions = async () => {
    if (known) return versions
    const result = await session.listVersions(entry.slotId)
    if (!result.ok) {
      report(result)
      return null
    }
    setVersions(result.value)
    return result.value
  }

  // Once read, the list follows the slot: a new swipe or a deleted one reads it again.
  const stale = versions !== null && !known
  useEffect(() => {
    if (!stale) return
    void session.listVersions(entry.slotId).then((result) => {
      if (result.ok) setVersions(result.value)
    })
  }, [stale, session, entry.slotId, entry.versionCount])

  const swipe = async (step: -1 | 1) => {
    const all = await loadVersions()
    if (all === null) return
    const index = all.findIndex((v) => v.id === version.id)
    const target = all[index + step]
    if (target) return report(await session.select(entry, target))
    // Past the last version of a reply, a swipe generates another, as in SillyTavern.
    if (step === 1 && model) report(await session.regenerate(entry))
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") swipeStart.current = { x: event.clientX, y: event.clientY }
  }
  const onPointerUp = (event: PointerEvent) => {
    const start = swipeStart.current
    swipeStart.current = null
    if (!start) return
    const dx = event.clientX - start.x
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 2 * Math.abs(event.clientY - start.y)) void swipe(dx < 0 ? 1 : -1)
  }

  return (
    <article
      aria-label={model ? "Reply" : "Your message"}
      data-slot={entry.slotId}
      className={`flex touch-pan-y flex-col gap-2 rounded-lg border px-4 py-3 ${
        highlighted
          ? "border-accent bg-surface"
          : model
            ? "border-border bg-surface"
            : "border-transparent bg-surface-raised"
      }`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{nameOf(cast, version.speakerEntityId) ?? (model ? "Model" : "You")}</span>
        {flagged.has(version.status) && (
          <Badge tone={version.status === "failed" ? "danger" : version.status === "generating" ? "accent" : "warning"}>
            {version.status}
          </Badge>
        )}
        {!entry.inContext && !generating && version.status !== "failed" && <Badge>not in context</Badge>}
        {(model || entry.versionCount > 1) && (
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Versions">
            <Button variant="ghost" aria-label="Previous version" disabled={position === 0} onClick={() => swipe(-1)}>
              ‹
            </Button>
            <span className="min-w-12 text-center text-muted tabular-nums" onPointerEnter={() => void loadVersions()}>
              {position >= 0 ? `${position + 1} / ${entry.versionCount}` : `${entry.versionCount}`}
            </span>
            <Button
              variant="ghost"
              aria-label={
                model && (position === -1 || position === entry.versionCount - 1)
                  ? "Generate another version"
                  : "Next version"
              }
              disabled={!model && position === entry.versionCount - 1}
              onClick={() => swipe(1)}
            >
              ›
            </Button>
          </div>
        )}
      </header>
      {editing ? (
        <Editor
          initial={version.content}
          onCancel={() => setEditing(false)}
          onSave={async (text) => {
            const outcome = await session.edit(entry, text)
            report(outcome)
            if (outcome.ok) setEditing(false)
          }}
        />
      ) : (
        <VersionBody version={version} session={session} parentSlotId={entry.parentSlotId} />
      )}
      {model && version.direction && (
        <p className="text-xs text-muted">
          <span className="font-medium">Direction:</span> {version.direction}
        </p>
      )}
      <footer className="flex flex-wrap gap-1">
        {generating && (
          <Button variant="secondary" onClick={async () => report(await session.stop(version.id))}>
            Stop
          </Button>
        )}
        {model && (
          <Button variant="ghost" onClick={async () => report(await session.regenerate(entry))}>
            Regenerate
          </Button>
        )}
        {!editing && !generating && (
          <Button variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <Link
          to="."
          search={{ leaf: entry.slotId }}
          className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted hover:bg-surface-raised hover:text-text"
        >
          Branch from here
        </Link>
        <Link
          to="."
          search={branchLeaf === null ? { slot: entry.slotId } : { leaf: branchLeaf, slot: entry.slotId }}
          className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted hover:bg-surface-raised hover:text-text"
        >
          Link
        </Link>
        {entry.versionCount > 1 && (
          <Button variant="ghost" onClick={async () => report(await session.deleteVersion(version.id))}>
            Delete version
          </Button>
        )}
        <Button variant="ghost" onClick={async () => report(await session.deleteMessage(entry.slotId))}>
          Delete
        </Button>
      </footer>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}
    </article>
  )
})
