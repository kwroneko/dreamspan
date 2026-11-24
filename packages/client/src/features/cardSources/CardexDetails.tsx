import type { RemoteSummary } from "@dreamspan/shared/cardSources.ts"
import type { Doc } from "@dreamspan/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { SourceFamily } from "./family.tsx"
import { problemText, type SourceOutcome, useSourceCall } from "./remote.ts"

interface Listing {
  readonly summary: RemoteSummary
  readonly doc: Doc | null
}

const fieldLabels = [
  ["creator_notes", "Creator’s notes"],
  ["description", "Description"],
  ["personality", "Personality"],
  ["scenario", "Scenario"],
  ["mes_example", "Example messages"],
  ["system_prompt", "System prompt"],
  ["post_history_instructions", "Post-history instructions"]
] as const

const number = new Intl.NumberFormat()

export function CardexCreator({ summary }: { summary: RemoteSummary }) {
  const { creator, creatorQuery } = summary
  if (!creator) return null
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1 text-sm text-muted">
      <span>By</span>
      {creatorQuery ? (
        <Tooltip label={`Shows ${creator}’s profile and cards on cardex.`}>
          <Link
            to="/"
            search={{ show: "src.cardex", sf: { author: creatorQuery } } as never}
            className="inline-flex min-h-9 min-w-0 items-center rounded-sm text-accent underline-offset-4 outline-none [overflow-wrap:anywhere] hover:underline focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          >
            {creator}
          </Link>
        </Tooltip>
      ) : (
        <span className="min-w-0 [overflow-wrap:anywhere]">{creator}</span>
      )}
    </div>
  )
}

export function OpenOnCardex({ url }: { url: string | undefined }) {
  if (!url)
    return (
      <Button
        disabled
        focusableWhenDisabled
        className="pointer-coarse:h-11"
        hint="Cardex did not provide a listing link."
      >
        Open on cardex
        <Icon name="external" size={14} />
      </Button>
    )
  return (
    <Tooltip label="Opens the public listing on cardex in a new browser tab.">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${buttonClass("secondary")} pointer-coarse:h-11`}
      >
        Open on cardex
        <Icon name="external" size={14} />
      </a>
    </Tooltip>
  )
}

function ListingBody({
  listing: { summary, doc },
  editorName
}: {
  listing: Listing
  /** The read-only editor already shows the creator and link. */
  editorName?: string | undefined
}) {
  const greetings = Array.isArray(doc?.alternate_greetings) ? doc.alternate_greetings.length : 0
  const book = doc?.character_book
  const entries =
    book && typeof book === "object" && "entries" in book && Array.isArray(book.entries) ? book.entries.length : 0
  const metrics = [
    ["Popularity", summary.stats?.popularity],
    ["Archive tokens", summary.tokens],
    ["Alternate greetings", greetings || undefined],
    ["Lorebook entries", entries || undefined]
  ] as const
  const archive = summary.tokenCounts
  const estimates = archive
    ? [
        ...fieldLabels.map(([field, label]) => [label, archive.fields[field]] as const),
        ...archive.greetings.map(
          (count, index) => [index === 0 ? "First message" : `Alternate greeting ${index}`, count] as const
        )
      ].flatMap(([label, count]) => (count === undefined ? [] : [{ label, count }]))
    : []
  return (
    <div className="flex min-w-0 flex-col gap-4 py-1">
      {(editorName === undefined || editorName !== summary.name) && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold [overflow-wrap:anywhere]">{summary.name}</h3>
          {editorName === undefined && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardexCreator summary={summary} />
              {summary.url && <OpenOnCardex url={summary.url} />}
            </div>
          )}
        </div>
      )}
      {metrics.some(([, value]) => value !== undefined) && (
        <dl className="grid grid-cols-2 gap-3 rounded-md border border-border bg-surface-raised p-3">
          {metrics.map(([label, value]) =>
            value === undefined ? null : (
              <div key={label}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="text-base font-semibold text-text tabular-nums">{number.format(value)}</dd>
              </div>
            )
          )}
        </dl>
      )}
      {summary.tags.length > 0 && (
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-medium">Listing tags</h3>
          <ul aria-label="Listing tags" className="flex min-w-0 flex-wrap gap-1.5">
            {[...new Set(summary.tags)].map((tag) => (
              <li key={tag} className="min-w-0 max-w-full">
                <Badge wrap>{tag}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
      {Boolean(summary.earlierOrigins?.length) && (
        <ul aria-label="Earlier listings" className="flex flex-col divide-y divide-border">
          {summary.earlierOrigins?.map(({ label, url }) => (
            <li key={url}>
              <Tooltip label="Opens this earlier listing on cardex in a new browser tab.">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-9 items-center justify-between gap-2 rounded-sm py-2 text-sm text-accent outline-none [overflow-wrap:anywhere] hover:underline focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:min-h-11"
                >
                  {label}
                  <Icon name="external" size={14} className="shrink-0" />
                </a>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      {archive && estimates.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Field token estimates</h3>
          <p className="text-xs text-muted [overflow-wrap:anywhere]">Counted by cardex with {archive.model}.</p>
          <dl className="divide-y divide-border text-sm">
            {estimates.map(({ label, count }) => (
              <div key={label} className="flex justify-between gap-3 py-1.5">
                <dt className="text-muted">{label}</dt>
                <dd className="text-right tabular-nums">{number.format(count)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  )
}

/** A saved copy reads the listing on request, without substituting its local fields for archive data. */
function LoadListing({ remoteId }: { remoteId: string }) {
  const call = useSourceCall()
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<SourceOutcome<Listing> | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void call((client) => client("SourceCard", { sourceId: "cardex", remoteId }), controller.signal).then((out) => {
      if (!out) return
      if (!out.ok) setResult(out)
      else {
        const { summary, docJson } = out.value
        setResult({ ok: true, value: { summary, doc: docJson === null ? null : (JSON.parse(docJson) as Doc) } })
      }
    })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `call` is a fresh closure
  }, [remoteId, attempt])
  if (!result) return <p className="py-2 text-sm text-muted">Loading the listing…</p>
  if (result.ok) return <ListingBody listing={result.value} />
  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <p className="text-sm text-muted">{problemText("cardex", result.problem)}</p>
      <Button
        hint="Asks cardex for the listing again."
        onClick={() => {
          setResult(null)
          setAttempt((previous) => previous + 1)
        }}
      >
        Retry
      </Button>
    </div>
  )
}

export function CardexDetails({ remoteId, name, listing }: { remoteId: string; name: string; listing?: Listing }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<"listing" | "family">("listing")
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <>
          <Icon name="info" size={16} />
          cardex details
        </>
      }
      triggerLabel="cardex details"
      title="cardex details"
      triggerClassName={`${buttonClass("secondary")} pointer-coarse:h-11`}
      hint={
        listing
          ? "Shows listing tags, archive statistics, versions and forks."
          : "Shows the public listing’s creator, tags, statistics and earlier links."
      }
      hintSide="bottom"
      side={listing ? "bottom" : "top"}
      wide
    >
      {listing ? (
        <div className="flex min-h-0 flex-col pointer-coarse:[&_[role=tab]]:min-h-11">
          <Tabs
            label="Cardex details"
            value={tab}
            onValueChange={setTab}
            panelClassName="overflow-y-auto px-1"
            tabs={[
              {
                value: "listing",
                label: "Listing",
                description: "Shows the listing’s statistics, tags, token estimates and earlier links.",
                panel: <ListingBody listing={listing} editorName={name} />
              },
              {
                value: "family",
                label: "Versions and forks",
                description: "Shows the cards that cardex links as versions, origins or forks.",
                panel: <SourceFamily sourceId="cardex" sourceName="cardex" remoteId={remoteId} name={name} inEditor />
              }
            ]}
          />
        </div>
      ) : (
        <div className="min-h-0 overflow-y-auto px-1">
          <LoadListing key={remoteId} remoteId={remoteId} />
        </div>
      )}
    </Popover>
  )
}
