// A creator's cards on a card source (spec/CARD-SOURCES.md §0: every criterion; §3.3's "cards
// by <creator>"): the source's browsing view with its creator filter set, so the URL holds it
// (a reload or a second tab shows the same view) and every filter and sort still applies. Above
// the results, the creator's public profile as the source gives it, and Not by this creator.
import type { RemoteCreator } from "@rp/shared/cardSources.ts"
import { useEffect, useState } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { SourceBrowse } from "./browse.tsx"
import { problemText, remoteImageUrl, type SourceProblem, useSourceCall } from "./remote.ts"

/** A creator as a list filter takes it: a backslash escapes a comma (cardex's creator lists). */
const escapeListed = (value: string) => value.replace(/\\/g, "\\\\").replace(/,/g, "\\,")

/** The one creator the browsing view is narrowed to, or null. */
export const shownCreator = (browse: SourceBrowse): string | null => {
  const filterId = browse.caps?.creators?.filterId
  const value = filterId === undefined ? undefined : browse.remote.filters[filterId]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

/** The creator filter's id: the one capabilities name, else a text filter that looks like it. */
const creatorFilterId = (browse: SourceBrowse) =>
  browse.caps?.creators?.filterId ??
  browse.caps?.filters.find((f) => f.kind === "text" && /author|creator/i.test(f.id))?.id

/** Narrows the view to one creator's cards; with no creator filter, searches for the name. */
export const showCreator = (browse: SourceBrowse, creator: string) => {
  const filterId = creatorFilterId(browse)
  if (filterId) browse.change({ filters: { ...browse.remote.filters, [filterId]: creator } }, { replace: false })
  else browse.change({ text: creator }, { replace: false })
}

/** Whether the source can leave a creator's cards out. */
export const canHideCreator = (browse: SourceBrowse) => browse.caps?.creators?.excludeFilterId !== undefined

/** Not by this creator: their cards leave the view (added to the excluded creators), the rest stay. */
export const hideCreator = (browse: SourceBrowse, creator: string) => {
  const creators = browse.caps?.creators
  if (!creators?.excludeFilterId) return
  const filters = { ...browse.remote.filters }
  if (filters[creators.filterId] === creator) delete filters[creators.filterId]
  const current = filters[creators.excludeFilterId]
  const listed = typeof current === "string" && current !== "" ? current.split(/(?<!\\),/) : []
  const entry = escapeListed(creator)
  filters[creators.excludeFilterId] = listed.includes(entry) ? listed.join(",") : [...listed, entry].join(",")
  browse.change({ filters }, { replace: false })
}

const monthYear = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short" })
const numberFormat = new Intl.NumberFormat()

/** The profile's facts as one muted line: its site, its counts, since when the source knows it. */
const factsOf = (profile: RemoteCreator, sourceName: string) =>
  [
    profile.site ? `On ${profile.site}` : null,
    profile.cards !== undefined
      ? `${numberFormat.format(profile.cards)} ${profile.cards === 1 ? "card" : "cards"}`
      : null,
    profile.lorebooks
      ? `${numberFormat.format(profile.lorebooks)} ${profile.lorebooks === 1 ? "lorebook" : "lorebooks"}`
      : null,
    profile.firstSeen !== undefined ? `on ${sourceName} since ${monthYear.format(profile.firstSeen)}` : null
  ]
    .filter((part) => part !== null)
    .join(" · ")

/**
 * The creator's profile above their cards: picture, name, facts, bio (folded), their page on
 * the source, and Not by this creator. It asks the source only while the view shows them.
 */
export function CreatorHeader({ browse, creator }: { browse: SourceBrowse; creator: string }) {
  const info = browse.info!
  const profiles = browse.caps?.creators?.profiles === true
  const call = useSourceCall()
  const key = `${info.id}\u0000${creator}`
  const [state, setState] = useState<{ key: string; profile?: RemoteCreator; problem?: SourceProblem } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!profiles) return
    const controller = new AbortController()
    void call((client) => client("SourceCreator", { sourceId: info.id, creator }), controller.signal).then((out) => {
      if (out === null) return
      setState(out.ok ? { key, profile: out.value } : { key, problem: out.problem })
    })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key names the request; `call` is a fresh closure
  }, [key, attempt, profiles])
  const current = state?.key === key ? state : null
  const profile = current?.profile
  const name = profile?.name ?? creator
  const bioLong = (profile?.bio?.length ?? 0) > 240 || (profile?.bio?.split("\n").length ?? 0) > 3
  return (
    <section
      data-source-creator={creator}
      aria-label={`Cards by ${name}`}
      className="flex min-w-0 gap-3 rounded-md border border-border p-3"
    >
      <Avatar
        id={`${info.id}:creator:${creator}`}
        name={name}
        size="xl"
        {...(profile?.avatar ? { src: remoteImageUrl(info.id, profile.avatar) } : {})}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 className="text-base font-semibold break-words">Cards by {name}</h2>
        {profile ? (
          <p className="text-sm text-muted">{factsOf(profile, info.name) || creator}</p>
        ) : current?.problem ? (
          <p className="text-sm text-muted">
            {current.problem.reason === "not_found"
              ? `${info.name} has no profile for this creator.`
              : `Couldn't show this creator's profile. ${problemText(info.name, current.problem)}`}{" "}
            {current.problem.reason !== "not_found" && (
              <Button
                variant="ghost"
                className="h-7 px-2 text-xs"
                hint={`Asks ${info.name} for the profile again.`}
                onClick={() => setAttempt((n) => n + 1)}
              >
                Retry
              </Button>
            )}
          </p>
        ) : profiles ? (
          <p className="text-sm text-muted">Asking {info.name}…</p>
        ) : null}
        {profile?.bio && (
          <>
            <p
              data-creator-bio
              className={`text-sm break-words whitespace-pre-wrap text-muted ${open || !bioLong ? "" : "line-clamp-3"}`}
            >
              {profile.bio}
            </p>
            {bioLong && (
              <div>
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  hint={open ? "Click to fold the creator's bio" : "Click to show all of the creator's bio"}
                  onClick={() => setOpen(!open)}
                >
                  {open ? "Show less" : "Show more"}
                </Button>
              </div>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          {canHideCreator(browse) && (
            <Button
              hint={`Leaves ${name}'s cards out and shows everyone else's.`}
              onClick={() => hideCreator(browse, creator)}
            >
              Not by this creator
            </Button>
          )}
          {profile?.url && (
            <Tooltip label={`Opens ${name}'s page on ${info.name}, in a new tab.`}>
              <a href={profile.url} target="_blank" rel="noopener noreferrer" className="text-sm text-accent">
                Open on {info.name}
              </a>
            </Tooltip>
          )}
        </div>
      </div>
    </section>
  )
}
