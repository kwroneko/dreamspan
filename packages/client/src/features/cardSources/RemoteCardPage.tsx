// A card on a card source, shown without adding it (spec/CARD-SOURCES.md §3.5, in brief): its
// picture, name, creator, tags and definitions, read from the source through the server and
// recorded as recently viewed. Starting a chat with it and adding it come with trying (§4).
import { RegistryContext } from "@effect/atom-react"
import type { RemoteSummary } from "@rp/shared/cardSources.ts"
import { Link, useParams } from "@tanstack/react-router"
import { useContext, useEffect, useState } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Badge, Card, EmptyState } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useTitle } from "../shell.tsx"
import { useSourceList } from "./browse.tsx"
import { recentAtom, remoteImageUrl, type SourceProblem, useSourceCall } from "./remote.ts"

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

function Folded({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 400 || text.split("\n").length > 4
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h3 className="text-sm font-medium">{label}</h3>
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

const problemText = (name: string, problem: SourceProblem) =>
  problem.reason === "not_found"
    ? `This card is no longer on ${name}.`
    : problem.reason === "unreachable"
      ? `Can't reach ${name} right now.`
      : problem.reason === "rate_limited"
        ? `${name} is limiting requests. Try again in a moment.`
        : problem.reason === "unauthorized"
          ? `${name} refused the API key.`
          : problem.reason === "disabled"
            ? `${name} is turned off in Settings.`
            : problem.reason === "bad_response"
              ? `${name} sent something this app can't read.`
              : "message" in problem
                ? problem.message
                : `${name} couldn't answer.`

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
            {summary.creator && <p className="text-sm text-muted">by {summary.creator}</p>}
            <p className="text-sm text-muted">On {name}. It isn't in your cards.</p>
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
          {FIELDS.map(([field, label]) => {
            const text = doc[field]
            return text ? <Folded key={field} label={label} text={text} /> : null
          })}
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
