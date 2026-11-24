// A card's family on a card source (spec/CARD-SOURCES.md §3.7 and §10 item 9): what the card was
// forked from or listed as before, its versions and its forks, as the source lists them. Each
// can be inspected or tried in a draft chat without adding it; the user's own are marked and
// open their card. Shown on a source card's page and, on request, in a card's Sources.
import { remoteEntityId, type RemoteRelative } from "@dreamspan/shared/cardSources.ts"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { problemText, remoteImageUrl, type SourceProblem, useSourceCall } from "./remote.ts"

const dayFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" })

/** How the row is related to the card, in a few words. */
const relationText = (item: RemoteRelative) =>
  item.relation === "parent"
    ? "Forked from"
    : item.relation === "earlier"
      ? "Earlier listing"
      : item.relation === "fork"
        ? "Fork"
        : item.current
          ? "Current version"
          : "Older version"

const detailsOf = (item: RemoteRelative) =>
  [
    relationText(item) + (item.versionLabel ? ` ${item.versionLabel}` : ""),
    item.creator ? `by ${item.creator}` : null,
    item.site ?? null,
    item.at !== undefined ? dayFormat.format(item.at) : null
  ]
    .filter((part) => part !== null)
    .join(" · ")

function RelativeRow({ item, sourceId, inEditor }: { item: RemoteRelative; sourceId: string; inEditor: boolean }) {
  const params = { sourceId, remoteId: item.remoteId }
  const actionClass = `${buttonClass("ghost")} ${inEditor ? "px-2 pointer-coarse:h-11" : "h-7 px-2 text-xs"}`
  return (
    <li data-family-card={item.remoteId} className="flex min-w-0 items-center gap-3 py-2">
      <Avatar
        id={`${sourceId}:${item.remoteId}`}
        name={item.name}
        size="lg"
        {...(item.thumb ? { src: remoteImageUrl(sourceId, item.thumb) } : {})}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`flex min-w-0 items-center gap-1.5 ${inEditor ? "flex-wrap" : ""}`}>
          <span
            data-layout-name
            className={`text-sm font-medium ${inEditor ? "[overflow-wrap:anywhere]" : "truncate"}`}
          >
            {item.name}
          </span>
          {item.held && (
            <Badge tone="accent">
              <span data-family-held>{item.held.archived ? "Yours, archived" : "Yours"}</span>
            </Badge>
          )}
        </span>
        <span className={`text-xs text-muted ${inEditor ? "[overflow-wrap:anywhere]" : "truncate"}`}>
          {detailsOf(item)}
        </span>
        <span className={`flex flex-wrap gap-1 ${inEditor ? "pt-1" : "pt-2"}`}>
          {inEditor && (
            <Tooltip label={`Shows ${item.name}’s fields in the card editor.`}>
              <Link
                to="/library/$refId"
                params={{ refId: remoteEntityId(sourceId, item.remoteId) }}
                className={actionClass}
              >
                Open in editor
              </Link>
            </Tooltip>
          )}
          {item.held ? (
            <Tooltip label={`Opens your ${item.name}.`}>
              <Link to="/cards/$entityId" params={{ entityId: item.held.entityId }} className={actionClass}>
                Open yours
              </Link>
            </Tooltip>
          ) : (
            <Tooltip label={`Opens a new chat with ${item.name}. It joins your cards when you send.`}>
              <Link to="/sources/$sourceId/cards/$remoteId/chat" params={params} className={actionClass}>
                Chat
              </Link>
            </Tooltip>
          )}
          {!inEditor && (
            <Tooltip label={`Shows ${item.name}'s definitions without starting a chat.`}>
              <Link to="/sources/$sourceId/cards/$remoteId" params={params} className={actionClass}>
                Inspect
              </Link>
            </Tooltip>
          )}
        </span>
      </div>
    </li>
  )
}

/** The family list: asked of the source when shown. */
export function SourceFamily({
  sourceId,
  sourceName,
  remoteId,
  name,
  inEditor = false
}: {
  sourceId: string
  sourceName: string
  remoteId: string
  name: string
  inEditor?: boolean
}) {
  const call = useSourceCall()
  const key = `${sourceId}\u0000${remoteId}`
  const [state, setState] = useState<{
    key: string
    items?: ReadonlyArray<RemoteRelative>
    more?: boolean
    problem?: SourceProblem
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void call((client) => client("SourceFamily", { sourceId, remoteId }), controller.signal).then((out) => {
      if (out === null) return
      setState(out.ok ? { key, items: out.value.items, more: out.value.more } : { key, problem: out.problem })
    })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key names the request; `call` is a fresh closure
  }, [key, attempt])
  const current = state?.key === key ? state : null
  return (
    <section
      data-source-family
      aria-label={`${name}'s family on ${sourceName}`}
      className="flex min-w-0 flex-col gap-1"
    >
      {current?.problem ? (
        <p className="text-sm text-muted">
          {current.problem.reason === "not_found"
            ? `${sourceName} has no family listed for this card.`
            : problemText(sourceName, current.problem)}{" "}
          {current.problem.reason !== "not_found" && (
            <Button
              variant="ghost"
              className={inEditor ? "pointer-coarse:h-11" : "h-7 px-2 text-xs"}
              hint={`Asks ${sourceName} for this card's family again.`}
              onClick={() => setAttempt((n) => n + 1)}
            >
              Retry
            </Button>
          )}
        </p>
      ) : !current?.items ? (
        <p className="text-sm text-muted">Asking {sourceName}…</p>
      ) : current.items.length === 0 ? (
        <p className="text-sm text-muted">{sourceName} lists no other versions, origins or forks of this card.</p>
      ) : (
        <>
          <ul className="flex min-w-0 flex-col divide-y divide-border">
            {current.items.map((item) => (
              <RelativeRow
                key={`${item.relation}:${item.remoteId}`}
                item={item}
                sourceId={sourceId}
                inEditor={inEditor}
              />
            ))}
          </ul>
          {current.more && <p className="text-xs text-muted">{sourceName} lists more; these are the first.</p>}
        </>
      )}
    </section>
  )
}
