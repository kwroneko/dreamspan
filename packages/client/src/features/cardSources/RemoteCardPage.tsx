// A card on a card source, shown without adding it (spec/CARD-SOURCES.md §3.5, in brief): its
// picture, name, creator, tags and definitions, read from the source through the server and
// recorded as recently viewed, with Add to my cards (§4.5); a card the user already has from
// there says so and links to theirs. Starting a chat with it comes with trying (§4.2).
import { RegistryContext } from "@effect/atom-react"
import type { RemoteSummary } from "@rp/shared/cardSources.ts"
import { Link, useParams } from "@tanstack/react-router"
import { useContext, useEffect, useState } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Badge, Card, EmptyState } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useTitle } from "../shell.tsx"
import { AboutHint } from "../../ui/AboutHint.tsx"
import { useCapabilities, useSourceList } from "./browse.tsx"
import { SourceFamily } from "./family.tsx"
import {
  type Adopted,
  problemText,
  recentAtom,
  remoteImageUrl,
  type SourceProblem,
  useAdoptRemote,
  useSourceCall
} from "./remote.ts"

/** What SourceCard answers: the card as listed, and its parsed document. */
interface RemoteCard {
  readonly summary: RemoteSummary
  readonly docJson: string | null
}

interface Definitions {
  readonly description?: string
  readonly personality?: string
  readonly scenario?: string
  readonly first_mes?: string
  readonly alternate_greetings?: ReadonlyArray<string>
  readonly creator_notes?: string
  readonly character_book?: { readonly entries?: ReadonlyArray<unknown> }
}

const FIELDS = [
  ["creator_notes", "Creator's notes"],
  ["description", "Description"],
  ["personality", "Personality"],
  ["scenario", "Scenario"],
  ["first_mes", "First message"]
] as const

function Folded({
  label,
  text,
  tokens,
  model
}: {
  label: string
  text: string
  tokens?: number | undefined
  model?: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const long = text.length > 400 || text.split("\n").length > 4
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h3 className="text-sm font-medium">
        {label}
        {tokens !== undefined && (
          <>
            {" "}
            <Tooltip label={`Estimated by the archive with ${model ?? "its tokenizer"}.`}>
              <span className="font-normal text-muted">· {tokens.toLocaleString()} tokens</span>
            </Tooltip>
          </>
        )}
      </h3>
      <p className={`text-sm break-words whitespace-pre-wrap text-muted ${open || !long ? "" : "line-clamp-4"}`}>
        {text}
      </p>
      {long && (
        <div>
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            hint={
              open
                ? `Click to fold ${label.toLowerCase()} to four lines`
                : `Click to show all of ${label.toLowerCase()}`
            }
            onClick={() => setOpen(!open)}
          >
            {open ? "Show less" : "Show more"}
          </Button>
        </div>
      )}
    </section>
  )
}

export function RemoteCardPage() {
  const { sourceId = "", remoteId = "" } = useParams({ strict: false }) as { sourceId?: string; remoteId?: string }
  const list = useSourceList()
  const info = list?.find((s) => s.id === sourceId && s.enabled)
  const name = info?.name ?? sourceId
  const call = useSourceCall()
  const registry = useContext(RegistryContext)
  const [state, setState] = useState<{ key: string; card?: RemoteCard; problem?: SourceProblem } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = `${sourceId}/${remoteId}`
  const adopt = useAdoptRemote()
  const [adopted, setAdopted] = useState<{ key: string; card: Adopted } | null>(null)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    if (!info) return
    const controller = new AbortController()
    void call((client) => client("SourceCard", { sourceId, remoteId }), controller.signal).then((out) => {
      if (out === null) return
      setState(out.ok ? { key, card: out.value } : { key, problem: out.problem })
      // It is recently viewed now.
      if (out.ok) registry.refresh(recentAtom(sourceId))
    })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `call` is a fresh closure each render
  }, [key, attempt, info === undefined])
  const current = state?.key === key ? state : null
  const caps = useCapabilities(info ? sourceId : null).caps
  const creatorFilter = caps?.creators?.filterId
  useTitle(current?.card?.summary.name ?? "Card")
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
  if (current?.problem)
    return (
      <EmptyState title={problemText(name, current.problem)}>
        <Button hint={`Asks ${name} again.`} onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </Button>
      </EmptyState>
    )
  if (!current?.card) return <p className="p-2 text-sm text-muted">Asking {name}…</p>
  const { summary, docJson } = current.card
  const mine =
    adopted?.key === key
      ? { entityId: adopted.card.entityId, archived: false }
      : summary.held
        ? { entityId: summary.held.entityId, archived: summary.held.archived }
        : null
  const doc = (docJson ? JSON.parse(docJson) : {}) as Definitions
  const greetings = (doc.alternate_greetings ?? []).length
  const entries = doc.character_book?.entries?.length ?? 0
  return (
    <Card>
      <div data-remote-card-page className="flex min-w-0 flex-col gap-4 sm:flex-row">
        <div className="w-32 shrink-0 sm:w-40">
          <Avatar
            id={`${sourceId}:${remoteId}`}
            name={summary.name}
            size="fill"
            {...(summary.image ? { src: remoteImageUrl(sourceId, summary.image) } : {})}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-xl font-semibold break-words">{summary.name}</h1>
            {summary.creator && (
              <p className="text-sm text-muted">
                by{" "}
                {creatorFilter && summary.creatorQuery ? (
                  <Tooltip label={`Shows every card by ${summary.creator} on ${name}, with their profile.`}>
                    <Link
                      to="/"
                      search={{ show: `src.${sourceId}`, sf: { [creatorFilter]: summary.creatorQuery } } as never}
                      className="text-accent"
                    >
                      {summary.creator}
                    </Link>
                  </Tooltip>
                ) : (
                  summary.creator
                )}
              </p>
            )}
            <p className="text-sm text-muted">
              {mine === null
                ? `On ${name}. It isn't in your cards.`
                : mine.archived
                  ? `On ${name}. You have it, archived.`
                  : `On ${name}. You have it in your cards.`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mine === null && (
              <Tooltip label={`Opens a new chat with ${summary.name}. It joins your cards when you send.`}>
                <Link
                  to="/sources/$sourceId/cards/$remoteId/chat"
                  params={{ sourceId, remoteId }}
                  className={buttonClass("primary")}
                >
                  Start a chat
                </Link>
              </Tooltip>
            )}
            {mine === null ? (
              <Button
                disabled={adding}
                hint={`Adds ${summary.name} to your cards without starting a chat.`}
                onClick={() => {
                  setAdding(true)
                  void adopt(sourceId, name, remoteId).then((card) => {
                    setAdding(false)
                    if (card) setAdopted({ key, card })
                  })
                }}
              >
                Add to my cards
              </Button>
            ) : (
              <Tooltip label={`Opens your ${summary.name}.`}>
                <Link to="/cards/$entityId" params={{ entityId: mine.entityId }} className={buttonClass("primary")}>
                  Open your card
                </Link>
              </Tooltip>
            )}
          </div>
          {summary.tags.length > 0 && (
            <ul aria-label="Tags" className="flex flex-wrap gap-1">
              {summary.tags.map((tag) => (
                <li key={tag}>
                  <Badge>{tag}</Badge>
                </li>
              ))}
            </ul>
          )}
          {summary.url && (
            <div>
              <Tooltip label={`Opens this card's page on ${name}, in a new tab.`}>
                <a href={summary.url} target="_blank" rel="noopener noreferrer" className="text-sm text-accent">
                  Open on {name}
                </a>
              </Tooltip>
            </div>
          )}
          {summary.earlierOrigins?.map((entry) => (
            <Tooltip key={entry.url} label="Opens the earlier listing on the archive, in a new tab.">
              <a href={entry.url} target="_blank" rel="noopener noreferrer" className="text-sm text-accent">
                {entry.label}
              </a>
            </Tooltip>
          ))}
          {FIELDS.map(([field, label]) => {
            const text = doc[field]
            return text ? (
              <Folded
                key={field}
                label={label}
                text={text}
                tokens={field === "first_mes" ? summary.tokenCounts?.greetings[0] : summary.tokenCounts?.fields[field]}
                model={summary.tokenCounts?.model}
              />
            ) : null
          })}
          {caps?.families && (
            <section className="flex min-w-0 flex-col gap-1">
              <h2 className="text-sm font-medium">
                Versions and forks{" "}
                <AboutHint heading="Versions and forks">
                  Cards {name} lists as this one&apos;s versions, the card it was forked from or listed as before, and
                  its forks. You can try or inspect each without adding it; yours are marked.
                </AboutHint>
              </h2>
              <SourceFamily sourceId={sourceId} sourceName={name} remoteId={remoteId} name={summary.name} />
            </section>
          )}
          {(greetings > 0 || entries > 0) && (
            <p className="text-sm text-muted">
              {[
                greetings > 0 ? `${greetings} more ${greetings === 1 ? "greeting" : "greetings"}` : null,
                entries > 0 ? `a lorebook of ${entries} ${entries === 1 ? "entry" : "entries"}` : null
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
