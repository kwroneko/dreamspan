// Browsing a card source on home and in the sidebar (spec/CARD-SOURCES.md §3): the source's
// capabilities, its results page by page, and the parts the shared character controls add
// while a source is shown (its sorts, Filters, the results grid; the panel and chips are in filters.tsx).
// Nothing here contacts a source unless its option is open: every call below needs a
// source id, which is null otherwise (§5.1).
import { useAtomValue } from "@effect/atom-react"
import type {
  RemoteSummary,
  SourceCapabilities,
  SourceFilter,
  SourceFilterValue,
  SourceInfo,
  SourceQuery
} from "@dreamspan/shared/cardSources.ts"
import { Link, useNavigate, useRouter } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAction } from "../../actions.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { pressedButtonClass } from "../../ui/InlinePanel.tsx"
import { ContextMenu, Menu, MenuCheckboxItem, MenuItem } from "../../ui/Menu.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Alert, Badge, EmptyState } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { RemoteBrowse } from "../characters/homeSearch.ts"
import { SortDirection, type SortOrder, SortScroller } from "../characters/cardBrowse.tsx"
import { TILE_CLASS, TILE_SURFACE_CLASS, TileFace, useCharacterNavigation } from "../characters/shellData.tsx"
import { openOnPlainClick } from "../../ui/links.ts"
import {
  OPEN_BESIDE_HINT,
  OPEN_NEW_TAB_HINT,
  PAGE_BESIDE_HINT,
  openBeside,
  openPageBeside,
  useCanOpenBeside
} from "../../ui/openBeside.ts"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { canHideCreator, CreatorHeader, hideCreator, showCreator, shownCreator } from "./creator.tsx"
import {
  cardSourceViews,
  lorebookPath,
  recentAtom,
  REMOTE_EDITOR_HINT,
  remoteEditorHref,
  remoteImageUrl,
  SOURCES_KEY,
  sourcesAtom,
  type SourceProblem,
  useAdoptRemote,
  useAdoptRemoteLorebook,
  useSourceCall
} from "./remote.ts"

/** The sources this user has on, in the registry's order: what Show offers after the filters. */
function useEnabledSources(): ReadonlyArray<SourceInfo> {
  return useSourceList()?.filter((s) => s.enabled) ?? []
}

/** Every source and how it stands for this user; null while that's being read. */
export function useSourceList(): ReadonlyArray<SourceInfo> | null {
  const result = useAtomValue(sourcesAtom)
  return AsyncResult.isSuccess(result) ? result.value.sources : null
}

// Capabilities rarely change (the server keeps them a day): asked once per source per page load.
const capabilities = new Map<string, SourceCapabilities>()

/** A source's capabilities, asked once per page load; nothing is asked while `sourceId` is null. */
export function useCapabilities(sourceId: string | null) {
  const call = useSourceCall()
  const [state, setState] = useState<{
    id: string | null
    caps?: SourceCapabilities
    problem?: SourceProblem
  }>({ id: null })
  const [attempt, setAttempt] = useState(0)
  const cached = sourceId === null ? undefined : capabilities.get(sourceId)
  useEffect(() => {
    if (sourceId === null || capabilities.has(sourceId)) return
    const controller = new AbortController()
    void call((client) => client("SourceCapabilities", { sourceId }), controller.signal).then((out) => {
      if (out === null) return
      if (out.ok) capabilities.set(sourceId, out.value)
      setState(out.ok ? { id: sourceId, caps: out.value } : { id: sourceId, problem: out.problem })
    })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `call` is a fresh closure each render
  }, [sourceId, attempt])
  return {
    caps: cached ?? (state.id === sourceId ? state.caps : undefined),
    problem: cached || state.id !== sourceId ? undefined : state.problem,
    retry: () => setAttempt((n) => n + 1)
  }
}

/** The query sent: the user's choices, with the remembered (or the source's default) content rating. */
const queryOf = (caps: SourceCapabilities, info: SourceInfo, remote: RemoteBrowse): SourceQuery => {
  const filters: Record<string, SourceFilterValue> = { ...remote.filters }
  const ratings = caps.ratings
  if (ratings && filters[ratings.filterId] === undefined) {
    const rating = info.rating ?? ratings.default
    if (rating !== null) filters[ratings.filterId] = rating
  }
  const sort = caps.sorts.find((s) => s.id === remote.sort) ?? caps.sorts[0]
  return {
    text: caps.text ? remote.text.trim() : "",
    tags: caps.tags.include ? remote.tags : [],
    excludeTags: caps.tags.exclude ? remote.excludeTags : [],
    filters,
    sort: sort?.id ?? null,
    reverse: sort?.reversible === true && remote.reverse
  }
}

type Status = "loading" | "refreshing" | "ready" | "more" | "failed" | "more-failed"
type FirstPageRequest = { readonly key: string }
interface Results {
  readonly request: FirstPageRequest
  readonly items: ReadonlyArray<RemoteSummary>
  readonly next: string | null
  readonly capped?: boolean | undefined
  readonly total?: number | undefined
  readonly notice?: string | undefined
  readonly estimated?: boolean | undefined
  readonly hidden?: number | undefined
  readonly hiddenCapped?: boolean | undefined
  readonly status: Status
  readonly problem?: SourceProblem | undefined
}

const sourceOfKey = (key: string) => key.slice(0, key.indexOf("\u0000"))

/**
 * The results shown while `key`'s first page is asked for: nothing is blanked that's already
 * known. The same search asked again (the source shown again) keeps its cards, count and
 * notes as they are until the answer replaces them; another search of the same source keeps
 * the last one's, dimmed as loading, so the count and the grid don't flicker off in between.
 * Another source's results are never shown for this one.
 */
const asking = (r: Results | null, request: FirstPageRequest): Results => {
  const key = request.key
  if (r === null || sourceOfKey(r.request.key) !== sourceOfKey(key) || (r.status === "failed" && r.request.key !== key))
    return { request, items: [], next: null, status: "loading" }
  const status = r.request.key === key && r.status === "ready" ? "refreshing" : "loading"
  return { ...r, request, next: null, status, problem: undefined }
}

/**
 * A source's results for a query, a page at a time: typing waits 300 ms, and a new query
 * cancels the one in flight (the server drops the source's request when nobody waits on it).
 * Rate limited, it tries once more by itself when the source says it may.
 */
function useResults(sourceId: string | null, query: SourceQuery | null) {
  const call = useSourceCall()
  const key = sourceId !== null && query !== null ? `${sourceId}\u0000${JSON.stringify(query)}` : null
  const [results, setResults] = useState<Results | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Reopening the same query or retrying starts a new first page, even if its key matches.
  const request = useMemo(() => (key === null ? null : { key, attempt }), [key, attempt])
  const inFlight = useRef<AbortController | null>(null)
  const retried = useRef<string | null>(null)
  const first = useRef(true)
  const fetchPage = useCallback(
    (page: string | null, controller: AbortController) => {
      inFlight.current?.abort()
      inFlight.current = controller
      return call((client) => client("SourceSearch", { sourceId: sourceId!, query: query!, page }), controller.signal)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key stands for the source and query
    [key]
  )
  useEffect(() => {
    if (request === null) return
    const controller = new AbortController()
    const delay = first.current ? 0 : 300
    first.current = false
    const timer = setTimeout(() => {
      void fetchPage(null, controller).then((out) => {
        if (out === null || controller.signal.aborted) return
        setResults(
          out.ok
            ? {
                request,
                items: out.value.items,
                next: out.value.next,
                total: out.value.total,
                capped: out.value.totalCapped,
                estimated: out.value.totalEstimated,
                hidden: out.value.hidden,
                hiddenCapped: out.value.hiddenCapped,
                notice: out.value.notice,
                status: "ready"
              }
            : { request, items: [], next: null, status: "failed", problem: out.problem }
        )
      })
    }, delay)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [request, fetchPage])
  useEffect(() => () => inFlight.current?.abort(), [])
  // Nothing from a previous first-page request can supply a cursor during the debounce or fetch.
  const current = request === null ? null : results?.request === request ? results : asking(results, request)
  // Rate limited: one automatic retry when the source says it may (§5.4).
  const wait = current?.problem?.reason === "rate_limited" ? (current.problem.retryAfterMs ?? 5000) : null
  useEffect(() => {
    if (wait === null || key === null || retried.current === key || current?.status !== "failed") return
    const timer = setTimeout(() => {
      retried.current = key
      setAttempt((n) => n + 1)
    }, wait)
    return () => clearTimeout(timer)
  }, [wait, key, current?.status])
  const more = () => {
    if (current === null || current.status !== "ready" || current.next === null) return
    const controller = new AbortController()
    setResults({ ...current, status: "more" })
    void fetchPage(current.next, controller).then((out) => {
      if (out === null || controller.signal.aborted) return
      setResults((r) => {
        if (r === null || r.request !== current.request) return r
        if (!out.ok) return { ...r, status: "more-failed", problem: out.problem }
        const previous = out.value.reset ? [] : r.items
        const seen = new Set(previous.map((i) => i.remoteId))
        return {
          ...r,
          items: [...previous, ...out.value.items.filter((i) => !seen.has(i.remoteId))],
          next: out.value.next,
          total: out.value.reset ? out.value.total : (out.value.total ?? r.total),
          capped: out.value.reset ? out.value.totalCapped : (out.value.totalCapped ?? r.capped),
          estimated: out.value.totalEstimated ?? r.estimated,
          hidden: out.value.reset ? out.value.hidden : r.hidden,
          hiddenCapped: out.value.reset ? out.value.hiddenCapped : r.hiddenCapped,
          notice: out.value.notice,
          status: "ready"
        }
      })
    })
  }
  const retry = () => {
    if (current?.status === "more-failed") {
      setResults({ ...current, status: "ready", problem: undefined })
      return
    }
    setAttempt((n) => n + 1)
  }
  return { results: current, more, retry, waitMs: wait }
}

const numberFormat = new Intl.NumberFormat()

/** What a source option shows once open: its reported total, "~" when it's an estimate. */
export const totalLabel = (results: Results | null) =>
  results?.total === undefined
    ? null
    : `${results.estimated ? "~" : ""}${numberFormat.format(results.total)}${results.capped ? "+" : ""}`

/** How many filters are set, for the Filters button: tags, and the filters away from their default. */
const filterCount = (query: SourceQuery | null, caps: SourceCapabilities | undefined) =>
  query === null
    ? 0
    : query.tags.length +
      query.excludeTags.length +
      Object.entries(query.filters).filter(
        ([id, value]) => value !== false && !(caps?.ratings?.filterId === id && value === caps.ratings.default)
      ).length

export const requirementMet = (filter: SourceFilter, filters: SourceQuery["filters"]) => {
  if (filter.kind !== "toggle" || !filter.requires) return true
  const chosen = filters[filter.requires.filterId]
  const values = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : []
  return values.length === filter.requires.values.length && filter.requires.values.every((v) => values.includes(v))
}

/**
 * Everything a place (home, the sidebar) needs while a source may be shown: the sources Show
 * offers, and for the one open, its capabilities, results and the controls' state.
 */
export function useSourceBrowse(
  source: string | null,
  remote: RemoteBrowse,
  onRemote: (remote: RemoteBrowse, options?: { replace?: boolean }) => void
) {
  const sources = useEnabledSources()
  const info = sources.find((s) => s.id === source) ?? null
  const sourceId = info?.id ?? null
  const { caps, problem: capsProblem, retry: retryCaps } = useCapabilities(sourceId)
  const query = caps && info ? queryOf(caps, info, remote) : null
  const { results, more, retry, waitMs } = useResults(sourceId, query)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const action = useAction()
  const change = (next: Partial<RemoteBrowse>, options?: { replace?: boolean }) => {
    const merged = { ...remote, ...next }
    if (next.filters) {
      const filters = { ...next.filters }
      for (const filter of caps?.filters ?? []) if (!requirementMet(filter, filters)) delete filters[filter.id]
      merged.filters = filters
    }
    onRemote(merged, options)
    // The content rating is remembered on the account (§5.3).
    const ratingId = caps?.ratings?.filterId
    if (info && ratingId && next.filters && next.filters[ratingId] !== remote.filters[ratingId]) {
      const value = next.filters[ratingId]
      void action.run(
        (client) =>
          client("SetCardSourceRating", { sourceId: info.id, rating: typeof value === "string" ? value : null }),
        [SOURCES_KEY]
      )
    }
  }
  return {
    /** Show's source options, each with its count once it's the one open. */
    options: sources.map((s) => ({ id: s.id, name: s.name, count: s.id === sourceId ? totalLabel(results) : null })),
    /** The source shown, or null (none chosen, or it was turned off). */
    info,
    caps,
    query,
    remote,
    change,
    results,
    problem: capsProblem ?? results?.problem,
    more,
    retry: capsProblem ? retryCaps : retry,
    waitMs,
    filtersOpen,
    setFiltersOpen,
    filterCount: filterCount(query, caps)
  }
}

export type SourceBrowse = ReturnType<typeof useSourceBrowse>

const orderOf = (id: string): SortOrder =>
  /name|title|alpha/i.test(id) ? "name" : /date|added|created|updated|new|time/i.test(id) ? "date" : "count"

/** The source's sorts and the direction button, in the place of the local sort (§3.2). */
export function SourceSortControl({
  browse,
  compact = false,
  scrolls = false
}: {
  browse: SourceBrowse
  compact?: boolean
  /** Too narrow a place scrolls the choices alone; the direction stays beside them, in view. */
  scrolls?: boolean
}) {
  const sorts = browse.caps?.sorts ?? []
  const current = sorts.find((s) => s.id === browse.query?.sort) ?? sorts[0]
  const name = browse.info?.name ?? ""
  const direction = (
    <SortDirection
      order={orderOf(current?.id ?? "")}
      reversed={browse.query?.reverse ?? false}
      onToggle={() => browse.change({ reverse: !browse.remote.reverse })}
      disabledReason={current?.reversible === false || !current ? `${name} sorts this one way only.` : undefined}
    />
  )
  return (
    // Scrolling (Home), the direction aligns with the choices' row, as the local sort's does, whatever
    // the explanation under them on a narrow screen.
    <div className={`flex ${scrolls ? "min-w-0 items-start [&>button]:mt-[3px]" : "shrink-0 items-center"} gap-1`}>
      {compact || sorts.length === 0 ? (
        <Menu
          hint={`Chooses how ${name} sorts its cards.`}
          label="Sort by"
          align="start"
          trigger={
            <Button
              variant="ghost"
              className="h-8 gap-1 px-2"
              aria-label={`Sort by: ${current?.label ?? "…"}`}
              disabled={sorts.length === 0}
            >
              {current?.label ?? "Sort"}
              <Icon name="down" />
            </Button>
          }
        >
          {sorts.map((s) => (
            <MenuCheckboxItem
              key={s.id}
              description={`Sorts ${name}'s cards by ${s.label.toLowerCase()}.`}
              checked={s.id === current?.id}
              onCheckedChange={() => browse.change({ sort: s.id, reverse: false })}
            >
              {s.label}
            </MenuCheckboxItem>
          ))}
        </Menu>
      ) : (
        <SortScroller scrolls={scrolls}>
          <Segmented
            label="Sort by"
            inlineDescription={false}
            value={current?.id ?? null}
            onValueChange={(sort) => browse.change({ sort, reverse: false })}
            options={sorts.map((s) => ({
              value: s.id,
              label: s.label,
              description: `Sorts ${name}'s cards by ${s.label.toLowerCase()}.`
            }))}
          />
        </SortScroller>
      )}
      {direction}
    </div>
  )
}

/**
 * "N results · page X of Y": the pages loaded so far, of the archive's 48-card pages; then, on
 * the same line, `note` (what the source's defaults hid).
 */
export function SourceResultLine({ browse, note }: { browse: SourceBrowse; note?: ReactNode }) {
  const { results } = browse
  const total = totalLabel(results)
  const counted = results && total !== null && results.total !== 0
  if (!counted && !note) return null
  const loaded = results ? Math.max(1, Math.ceil(results.items.length / SOURCE_PAGE)) : 1
  const pages = !results || results.total === undefined ? null : Math.max(1, Math.ceil(results.total / SOURCE_PAGE))
  return (
    <p data-source-result-line className="min-h-5 text-sm leading-5 text-muted">
      {counted && (
        <>
          {total} {total === "1" ? "result" : "results"}
          {pages !== null &&
            pages > 1 &&
            ` · page ${numberFormat.format(loaded)} of ${numberFormat.format(pages)}${results.capped ? "+" : ""}`}
        </>
      )}
      {counted && note ? " · " : null}
      {note}
    </p>
  )
}
const SOURCE_PAGE = 48

/**
 * Filters: the last control of the sort row, only while a source is shown and only on a narrow
 * bar, where it opens the filters' sheet; a wide bar shows the filters themselves (§3.2).
 */
export function SourceFiltersButton({
  browse,
  panelId,
  compact = false
}: {
  browse: SourceBrowse
  panelId: string
  /** The icon and the count only, for a narrow bar. */
  compact?: boolean
}) {
  const count = browse.filterCount
  return (
    <Tooltip label={`Click to show every filter ${browse.info?.name ?? ""} offers`}>
      <Button
        variant="ghost"
        // Compact, the size of the bar's other icon buttons; the count is a small badge in its corner.
        className={`${compact ? "relative size-8! px-0!" : "h-8! gap-1 px-2!"} @xl:hidden ${pressedButtonClass}`}
        aria-pressed={browse.filtersOpen}
        aria-expanded={browse.filtersOpen}
        aria-controls={panelId}
        {...(compact ? { "aria-label": count > 0 ? `Filters: ${count} set` : "Filters" } : {})}
        onClick={() => browse.setFiltersOpen(!browse.filtersOpen)}
      >
        <Icon name="sliders" />
        {!compact && "Filters"}
        {count > 0 &&
          (compact ? (
            <span
              aria-hidden="true"
              data-layout-audit-ignore="overlap: The count is a badge on the icon's corner, keeping the button the size of its neighbours"
              className="absolute top-0.5 right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[10px] leading-none text-accent-contrast tabular-nums"
            >
              {count}
            </span>
          ) : (
            <span className="text-muted tabular-nums">{count}</span>
          ))}
      </Button>
    </Tooltip>
  )
}

/** Removes every filter: the content rating goes back to the source's default. */
export const clearFilters = (browse: SourceBrowse) => {
  const ratings = browse.caps?.ratings
  browse.change({
    tags: [],
    excludeTags: [],
    filters: ratings && ratings.default !== null ? { [ratings.filterId]: ratings.default } : {}
  })
}

/** The link to a remote card's page (§3.5). */
const cardLink = (sourceId: string, remoteId: string) =>
  ({ to: "/sources/$sourceId/cards/$remoteId", params: { sourceId, remoteId } }) as const

/** The link to a remote card's draft chat (§4.2): what a click on its tile opens. */
const chatLink = (sourceId: string, remoteId: string) =>
  ({ to: "/sources/$sourceId/cards/$remoteId/chat", params: { sourceId, remoteId } }) as const

/** A tile's muted line: the source's main stat and the token count, else the first tags (§3.3). */
const defaultLine = (card: RemoteSummary, caps: SourceCapabilities | undefined) => {
  const main = caps?.stats?.[0]
  const stat =
    main && card.stats?.[main.id] !== undefined ? `${numberFormat.format(card.stats[main.id]!)} ${main.label}` : null
  const tokens = card.tokens !== undefined ? `${numberFormat.format(card.tokens)} tokens` : null
  const parts = [stat, tokens].filter((p) => p !== null)
  return parts.length ? parts.join(" · ") : card.tags.slice(0, 3).join(", ")
}

/** A result: the tile of the user's own cards, with the source's lines (§3.3). No favourite star. */
function RemoteTile({ card, browse }: { card: RemoteSummary; browse: SourceBrowse }) {
  const [menu, setMenu] = useState(false)
  const info = browse.info!
  const view = cardSourceViews.get(info.id)
  const link = cardLink(info.id, card.remoteId)
  const chat = chatLink(info.id, card.remoteId)
  // The card's read-only page (Inspect's): View beside.
  const pageHref = `/sources/${encodeURIComponent(info.id)}/cards/${encodeURIComponent(card.remoteId)}`
  const canBeside = useCanOpenBeside()
  const navigate = useNavigate()
  const ratingShown = card.rating !== undefined
  const adopt = useAdoptRemote()
  const character = useCharacterNavigation()
  const router = useRouter()
  // The user's own card for it (§3.7): from the results, or just added here.
  const [added, setAdded] = useState<{ entityId: string; archived: boolean } | null>(null)
  const [flash, setFlash] = useState(false)
  const mine = added ?? (card.held ? { entityId: card.held.entityId, archived: card.held.archived } : null)
  // What a click opens: your card's chat, else the draft chat. Open beside and a new browser tab open it too.
  const entity = mine?.entityId as EntityId | undefined
  const heldChat = entity === undefined ? null : character.link(entity)
  const clickHref = heldChat === null ? `${pageHref}/chat` : router.buildLocation(heldChat).href
  const openMine = () => {
    if (entity !== undefined) character.open(entity)
  }
  const face = (
    <TileFace
      name={card.name}
      title={card.name}
      portrait={
        <>
          <Avatar
            id={`${info.id}:${card.remoteId}`}
            name={card.name}
            size="fill"
            {...(card.thumb ? { src: remoteImageUrl(info.id, card.thumb) } : {})}
          />
          {mine !== null && (
            <Tooltip label={mine.archived ? "You have this card, archived." : "You have this card."}>
              <span
                data-held-badge
                data-layout-overlay="The held badge sits over the portrait"
                tabIndex={0}
                aria-label={mine.archived ? "You have this card, archived" : "You have this card"}
                className="absolute top-2 left-2 inline-flex size-5 items-center justify-center rounded-sm bg-accent text-accent-contrast shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Icon name="check" size={14} />
              </span>
            </Tooltip>
          )}
          {card.held?.update && mine !== null && (
            <span
              data-held-update
              data-layout-overlay="The update badge sits over the portrait"
              className="absolute bottom-2 left-2"
            >
              <Badge tone="warning">update available</Badge>
            </span>
          )}
          {ratingShown && (
            <span
              data-layout-overlay="The content rating sits over the portrait"
              className="absolute top-2 right-2 rounded-sm border border-border bg-surface/90 px-1.5 text-[0.6875rem] font-medium"
            >
              {card.rating}
            </span>
          )}
        </>
      }
    >
      <span data-remote-creator data-layout-name className="truncate text-xs text-muted">
        {card.creator ? `by ${card.creator}` : " "}
      </span>
      <span className="mt-auto truncate text-xs text-muted">
        {view?.tileLine?.(card) ?? defaultLine(card, browse.caps)}
      </span>
    </TileFace>
  )
  const addToMine = () =>
    void adopt(info.id, info.name, card.remoteId).then((result) => {
      if (!result) return
      setAdded({ entityId: result.entityId, archived: false })
      // The tile flashes once as it becomes yours.
      setFlash(true)
      window.setTimeout(() => setFlash(false), 1200)
    })
  return (
    <div
      data-remote-card={card.remoteId}
      {...(mine !== null ? { "data-held": true } : {})}
      className={`${TILE_SURFACE_CLASS} [content-visibility:auto] [contain-intrinsic-size:auto_18rem] ${flash ? "ring-2 ring-accent" : ""}`}
    >
      <ContextMenu
        label={`Actions for ${card.name}`}
        open={menu}
        onOpenChange={setMenu}
        trigger={
          heldChat !== null ? (
            <Tooltip label={`Opens your ${card.name}.`}>
              <Link
                {...heldChat}
                onClick={openOnPlainClick(openMine)}
                aria-label={`Open ${card.name}`}
                className={`${TILE_CLASS} hover:border-focus`}
              >
                {face}
              </Link>
            </Tooltip>
          ) : (
            <Tooltip label={`Opens a new chat with ${card.name}. It joins your cards when you send.`}>
              <Link {...chat} aria-label={`Open ${card.name}`} className={`${TILE_CLASS} hover:border-focus`}>
                {face}
              </Link>
            </Tooltip>
          )
        }
      >
        {mine !== null ? (
          <MenuItem icon="person" description="Opens your copy, as a click does." onClick={openMine}>
            Open your card
          </MenuItem>
        ) : (
          <MenuItem
            icon="chat"
            description="Opens a new chat with it, as a click does."
            onClick={() => void navigate(chat)}
          >
            Open
          </MenuItem>
        )}
        {canBeside && (
          <MenuItem icon="split-right" description={OPEN_BESIDE_HINT} onClick={() => openBeside(clickHref)}>
            Open beside
          </MenuItem>
        )}
        <MenuItem
          icon="external"
          description={OPEN_NEW_TAB_HINT}
          onClick={() => window.open(clickHref, "_blank", "noopener")}
        >
          Open in a new browser tab
        </MenuItem>
        {/* The card's read-only page beside, to inspect many cards (owner, 2026-11-24). */}
        {canBeside && (
          <MenuItem icon="eye" description={PAGE_BESIDE_HINT} onClick={() => openPageBeside(pageHref)}>
            View beside
          </MenuItem>
        )}
        {mine === null && (
          <MenuItem
            icon="eye"
            description={`Shows ${card.name}'s definitions without starting a chat.`}
            onClick={() => void navigate(link)}
          >
            Inspect
          </MenuItem>
        )}
        {mine === null && (
          <MenuItem
            icon="edit"
            description={REMOTE_EDITOR_HINT}
            onClick={() => void navigate({ href: remoteEditorHref(info.id, card.remoteId) })}
          >
            Open in the editor
          </MenuItem>
        )}
        {mine === null && (
          <MenuItem
            icon="plus"
            description={`Adds ${card.name} to your cards without starting a chat.`}
            onClick={addToMine}
          >
            Add to my cards
          </MenuItem>
        )}
        {mine !== null && (
          <MenuItem
            icon="search"
            description={`Shows ${card.name} on ${info.name}, not your copy.`}
            onClick={() => void navigate(link)}
          >
            Show on {info.name}
          </MenuItem>
        )}
        {card.url !== undefined && (
          <MenuItem
            icon="external"
            description={`Opens this card's page on ${info.name}, in a new tab.`}
            onClick={() => window.open(card.url, "_blank", "noopener,noreferrer")}
          >
            Open on {info.name}
          </MenuItem>
        )}
        {card.creator !== undefined && shownCreator(browse) !== (card.creatorQuery ?? card.creator) && (
          <MenuItem
            icon="person"
            description={`Shows every card by ${card.creator} on ${info.name}, with their profile.`}
            onClick={() => showCreator(browse, card.creatorQuery ?? card.creator!)}
          >
            Cards by {card.creator}
          </MenuItem>
        )}
        {card.creatorQuery !== undefined && canHideCreator(browse) && (
          <MenuItem
            icon="ban"
            description={`Leaves ${card.creator ?? card.creatorQuery}'s cards out of these results.`}
            onClick={() => hideCreator(browse, card.creatorQuery!)}
          >
            Not by {card.creator ?? card.creatorQuery}
          </MenuItem>
        )}
      </ContextMenu>
    </div>
  )
}

/**
 * A standalone lorebook among the results (§3.9): the Lorebook badge on its picture's corner,
 * and opening it adds it, then shows it in the lorebook editor. One the user has from there
 * opens theirs. Nothing here inspects it or starts a chat with it.
 */
function RemoteLorebookTile({ card, browse }: { card: RemoteSummary; browse: SourceBrowse }) {
  const [menu, setMenu] = useState(false)
  const info = browse.info!
  const view = cardSourceViews.get(info.id)
  const href = lorebookPath(info.id, card.remoteId)
  const link = {
    to: "/sources/$sourceId/lorebooks/$remoteId",
    params: { sourceId: info.id, remoteId: card.remoteId }
  } as const
  const navigate = useNavigate()
  const adopt = useAdoptRemoteLorebook()
  const [added, setAdded] = useState<{ refId: string; archived: boolean } | null>(null)
  const [flash, setFlash] = useState(false)
  const mine = added ?? (card.held ? { refId: card.held.refId, archived: card.held.archived } : null)
  const face = (
    <TileFace
      name={card.name}
      title={card.name}
      portrait={
        <>
          <Avatar
            id={`${info.id}:${card.remoteId}`}
            name={card.name}
            size="fill"
            {...(card.thumb ? { src: remoteImageUrl(info.id, card.thumb) } : {})}
          />
          <Tooltip label="A lorebook, not a character. Opening it adds it to your lorebooks.">
            <span
              data-lorebook-badge
              data-layout-overlay="The lorebook badge sits over the picture"
              tabIndex={0}
              aria-label="Lorebook"
              className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-sm border border-border bg-surface/90 px-1.5 text-[0.6875rem] font-medium outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Icon name="book" size={12} />
              Lorebook
            </span>
          </Tooltip>
          {mine !== null && (
            <Tooltip label={mine.archived ? "You have this lorebook, archived." : "You have this lorebook."}>
              <span
                data-held-badge
                data-layout-overlay="The held badge sits over the picture"
                tabIndex={0}
                aria-label={mine.archived ? "You have this lorebook, archived" : "You have this lorebook"}
                className="absolute top-2 left-2 inline-flex size-5 items-center justify-center rounded-sm bg-accent text-accent-contrast shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Icon name="check" size={14} />
              </span>
            </Tooltip>
          )}
          {card.held?.update && mine !== null && (
            <span
              data-held-update
              data-layout-overlay="The update badge sits over the picture"
              className="absolute bottom-8 left-2"
            >
              <Badge tone="warning">update available</Badge>
            </span>
          )}
        </>
      }
    >
      <span data-remote-creator data-layout-name className="truncate text-xs text-muted">
        {card.creator ? `by ${card.creator}` : " "}
      </span>
      <span className="mt-auto truncate text-xs text-muted">
        {view?.tileLine?.(card) ?? defaultLine(card, browse.caps)}
      </span>
    </TileFace>
  )
  const addToMine = () =>
    void adopt(info.id, info.name, card.remoteId).then((out) => {
      if (!out?.ok) return
      setAdded({ refId: out.value.refId, archived: false })
      setFlash(true)
      window.setTimeout(() => setFlash(false), 1200)
    })
  const openMine = (refId: string) => void navigate({ to: "/library/$refId", params: { refId } })
  return (
    <div
      data-remote-card={card.remoteId}
      data-remote-lorebook
      {...(mine !== null ? { "data-held": true } : {})}
      className={`${TILE_SURFACE_CLASS} [content-visibility:auto] [contain-intrinsic-size:auto_18rem] ${flash ? "ring-2 ring-accent" : ""}`}
    >
      <ContextMenu
        label={`Actions for ${card.name}`}
        open={menu}
        onOpenChange={setMenu}
        trigger={
          mine !== null ? (
            <Tooltip label={`Opens your ${card.name} in the lorebook editor.`}>
              <Link
                to="/library/$refId"
                params={{ refId: mine.refId }}
                aria-label={`Open ${card.name}`}
                className={`${TILE_CLASS} hover:border-focus`}
              >
                {face}
              </Link>
            </Tooltip>
          ) : (
            <Tooltip label={`Adds ${card.name} to your lorebooks and opens it.`}>
              <Link {...link} aria-label={`Open ${card.name}`} className={`${TILE_CLASS} hover:border-focus`}>
                {face}
              </Link>
            </Tooltip>
          )
        }
      >
        {mine !== null ? (
          <MenuItem icon="book" description="Opens your copy, as a click does." onClick={() => openMine(mine.refId)}>
            Open your lorebook
          </MenuItem>
        ) : (
          <MenuItem
            icon="book"
            description="Adds it to your lorebooks and opens it, as a click does."
            onClick={() => void navigate(link)}
          >
            Open
          </MenuItem>
        )}
        {mine === null && (
          <MenuItem
            icon="plus"
            description={`Adds ${card.name} to your lorebooks without opening it.`}
            onClick={addToMine}
          >
            Add to my lorebooks
          </MenuItem>
        )}
        <MenuItem
          icon="external"
          description={
            mine === null
              ? "Adds it and opens it in a new tab of the browser."
              : "Opens it in a new tab of the browser."
          }
          onClick={() =>
            window.open(mine === null ? href : `/library/${encodeURIComponent(mine.refId)}`, "_blank", "noopener")
          }
        >
          Open in a new browser tab
        </MenuItem>
        {card.url !== undefined && (
          <MenuItem
            icon="external"
            description={`Opens this lorebook's page on ${info.name}, in a new tab.`}
            onClick={() => window.open(card.url, "_blank", "noopener,noreferrer")}
          >
            Open on {info.name}
          </MenuItem>
        )}
        {card.creator !== undefined && shownCreator(browse) !== (card.creatorQuery ?? card.creator) && (
          <MenuItem
            icon="person"
            description={`Shows everything by ${card.creator} on ${info.name}, with their profile.`}
            onClick={() => showCreator(browse, card.creatorQuery ?? card.creator!)}
          >
            More by {card.creator}
          </MenuItem>
        )}
        {card.creatorQuery !== undefined && canHideCreator(browse) && (
          <MenuItem
            icon="ban"
            description={`Leaves ${card.creator ?? card.creatorQuery}'s work out of these results.`}
            onClick={() => hideCreator(browse, card.creatorQuery!)}
          >
            Not by {card.creator ?? card.creatorQuery}
          </MenuItem>
        )}
      </ContextMenu>
    </div>
  )
}

/** What each failure says, worded for what the user can do (§5.4). */
function ProblemAlert({
  browse,
  problem,
  more = false
}: {
  browse: SourceBrowse
  problem: SourceProblem
  more?: boolean
}) {
  const name = browse.info?.name ?? "The source"
  const [now, setNow] = useState(() => Date.now())
  const [since] = useState(() => Date.now())
  const wait = browse.waitMs
  useEffect(() => {
    if (problem.reason !== "rate_limited") return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [problem.reason])
  const retry = (
    <Button hint={`Asks ${name} again.`} onClick={browse.retry}>
      Retry
    </Button>
  )
  if (more)
    return (
      <div
        data-source-more-failed
        className="col-span-full flex items-center justify-center gap-2 p-2 text-sm text-muted"
      >
        Couldn't load more ·
        <Button variant="ghost" hint={`Asks ${name} for the next cards again.`} onClick={browse.retry}>
          Retry
        </Button>
      </div>
    )
  switch (problem.reason) {
    case "unreachable":
      return (
        <Alert tone="warning" actions={retry}>
          Can't reach {name} right now.
        </Alert>
      )
    case "rate_limited": {
      const left = Math.max(0, Math.ceil(((wait ?? 0) - (now - since)) / 1000))
      return (
        <Alert tone="warning" actions={retry}>
          {name} is limiting requests.{left > 0 ? ` Trying again in ${left} s.` : ""}
        </Alert>
      )
    }
    case "unauthorized":
      return (
        <Alert tone="danger">
          {name} refused the API key.{" "}
          <Link to="/settings/card-sources" className="text-accent">
            Card sources settings
          </Link>
        </Alert>
      )
    case "disabled":
      return (
        <Alert tone="neutral">
          {name} is turned off in Settings.{" "}
          <Link to="/settings/card-sources" className="text-accent">
            Card sources settings
          </Link>
        </Alert>
      )
    case "bad_response":
      return (
        <Alert tone="danger" actions={retry}>
          {name} sent something this app can't read.
        </Alert>
      )
    case "region_unavailable":
      return (
        <Alert tone="neutral" actions={retry}>
          This card is not available in your region.
        </Alert>
      )
    case "refused":
      return (
        <Alert tone="neutral" actions={retry}>
          {name} refused this request.
        </Alert>
      )
    case "not_found":
      return (
        <Alert tone="neutral" actions={retry}>
          {name} has no such page.
        </Alert>
      )
    case "other":
      return (
        <Alert tone="danger" actions={retry}>
          {problem.message}
        </Alert>
      )
  }
}

/** Loads the next page as the last row nears the view (800 px), one page at a time (§3.4). */
function Sentinel({ onNear }: { onNear: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useRef(onNear)
  useEffect(() => {
    near.current = onNear
  })
  useEffect(() => {
    const node = ref.current!
    // The nearest scrolling ancestor is the root: the sidebar's list, or the page.
    let root: HTMLElement | null = node.parentElement
    while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement
    const observer = new IntersectionObserver(
      (entries) => node.isConnected && entries.some((e) => e.isIntersecting) && near.current(),
      {
        root,
        rootMargin: "0px 0px 800px 0px"
      }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return <div ref={ref} data-source-sentinel aria-hidden="true" className="col-span-full h-px" />
}

/** "Recently viewed on <source>": the cards opened from it, so one passed by mistake is found again. */
function RecentRow({ browse }: { browse: SourceBrowse }) {
  const info = browse.info!
  const result = useAtomValue(recentAtom(info.id))
  const action = useAction()
  const recent = AsyncResult.isSuccess(result) ? result.value : []
  if (recent.length === 0) return null
  return (
    <details data-source-recent className="group min-w-0 rounded-md border border-border px-3 py-1">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-sm font-medium text-muted outline-none select-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
        <Icon name="right" className="transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        Recently viewed on {info.name}
        <span className="font-normal tabular-nums">{recent.length}</span>
      </summary>
      <div className="flex min-w-0 flex-col gap-2 pb-2">
        <ul className="flex min-w-0 gap-2 overflow-x-auto p-2">
          {recent.map((r) => (
            <li key={r.remoteId} className="w-16 shrink-0">
              <Tooltip label={`Shows ${r.name} again.`}>
                <Link
                  {...(r.kind === "lorebook"
                    ? {
                        to: "/sources/$sourceId/lorebooks/$remoteId" as const,
                        params: { sourceId: info.id, remoteId: r.remoteId }
                      }
                    : cardLink(info.id, r.remoteId))}
                  className="flex flex-col items-center gap-1 text-center text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <Avatar
                    id={`${info.id}:${r.remoteId}`}
                    name={r.name}
                    size="xl"
                    {...(r.thumb ? { src: remoteImageUrl(info.id, r.thumb) } : {})}
                  />
                  <span data-layout-name className="w-full truncate">
                    {r.name}
                  </span>
                </Link>
              </Tooltip>
            </li>
          ))}
        </ul>
        <div>
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            hint="Empties this list. Nothing is removed from your library."
            pending={action.pending}
            onClick={() =>
              void action.run((client) => client("ClearRecentRemote", { sourceId: info.id }), [SOURCES_KEY])
            }
          >
            Clear
          </Button>
        </div>
      </div>
    </details>
  )
}

/**
 * The source's results in place of the user's cards: never mixed with them (§3.2). The recently
 * viewed row first, then the tiles, the next page as the end nears, and each state's line.
 */
export function SourceResults({ browse, className }: { browse: SourceBrowse; className: string }) {
  const { info, results, problem } = browse
  if (!info) return null
  const name = info.name
  const failed = results?.status === "failed" || (!browse.caps && problem)
  const loading = !failed && (results === null || (results.status === "loading" && results.items.length === 0))
  const items = results?.items ?? []
  const creator = browse.caps ? shownCreator(browse) : null
  return (
    <div
      data-source-results={info.id}
      aria-busy={results?.status === "loading" || results?.status === "refreshing" || results?.status === "more"}
      className="flex min-w-0 flex-col gap-3"
    >
      {creator !== null && <CreatorHeader key={creator} browse={browse} creator={creator} />}
      <RecentRow browse={browse} />
      {results?.notice && <Alert tone="neutral">{results.notice}</Alert>}
      {failed && problem ? (
        <ProblemAlert browse={browse} problem={problem} />
      ) : loading ? (
        <p className="p-2 text-sm text-muted">Asking {name}…</p>
      ) : items.length === 0 ? (
        <EmptyState title={`No cards on ${name} match this search`}>
          {browse.filterCount > 0 && (
            <Button hint="Removes every filter." onClick={() => clearFilters(browse)}>
              Clear filters
            </Button>
          )}
        </EmptyState>
      ) : (
        <div
          aria-label={`Cards on ${name}`}
          className={`${className} ${results?.status === "loading" ? "opacity-60" : ""}`}
        >
          {items.map((card) =>
            card.kind === "lorebook" ? (
              <RemoteLorebookTile key={card.remoteId} card={card} browse={browse} />
            ) : (
              <RemoteTile key={card.remoteId} card={card} browse={browse} />
            )
          )}
          {results?.status === "more-failed" && problem ? (
            <ProblemAlert browse={browse} problem={problem} more />
          ) : results?.next !== null && results?.status !== "loading" ? (
            <>
              {/* Remounted after each page, so a sentinel still in range asks for the next one. */}
              <Sentinel key={items.length} onNear={browse.more} />
              {results?.status === "more" && (
                <p className="col-span-full p-2 text-center text-sm text-muted">Loading more…</p>
              )}
            </>
          ) : (
            results?.status === "ready" && (
              <p data-source-end className="col-span-full p-2 text-center text-sm text-muted">
                That's every card for this search.
              </p>
            )
          )}
        </div>
      )}
    </div>
  )
}
