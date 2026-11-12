// Browsing a card source on home and in the sidebar (spec/CARD-SOURCES.md §3): the source's
// capabilities, its results page by page, and the parts the shared character controls add
// while a source is shown (its sorts, Filters and the panel, the chips, the results grid).
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
} from "@rp/shared/cardSources.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react"
import { useAction } from "../../actions.tsx"
import { AboutHint } from "../../ui/AboutHint.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { InlinePanel, pressedButtonClass } from "../../ui/InlinePanel.tsx"
import { ContextMenu, Menu, MenuCheckboxItem, MenuItem } from "../../ui/Menu.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Alert, Badge, EmptyState } from "../../ui/Surface.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import type { RemoteBrowse } from "../characters/homeSearch.ts"
import { SortDirection, type SortOrder } from "../characters/cardBrowse.tsx"
import { TILE_CLASS, TILE_SURFACE_CLASS, TileFace, useOpenCharacter } from "../characters/shellData.tsx"
import { openOnPlainClick } from "../../ui/links.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import {
  cardSourceViews,
  recentAtom,
  remoteImageUrl,
  SOURCES_KEY,
  sourcesAtom,
  type SourceProblem,
  useAdoptRemote,
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

function useCapabilities(sourceId: string | null) {
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

type Status = "loading" | "ready" | "more" | "failed" | "more-failed"
interface Results {
  readonly key: string
  readonly items: ReadonlyArray<RemoteSummary>
  readonly next: string | null
  readonly total?: number | undefined
  readonly notice?: string | undefined
  readonly estimated?: boolean | undefined
  readonly status: Status
  readonly problem?: SourceProblem | undefined
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
    if (key === null) return
    const controller = new AbortController()
    const delay = first.current ? 0 : 300
    first.current = false
    const timer = setTimeout(() => {
      setResults((r) => ({ key, items: r?.key === key ? r.items : (r?.items ?? []), next: null, status: "loading" }))
      void fetchPage(null, controller).then((out) => {
        if (out === null || controller.signal.aborted) return
        setResults(
          out.ok
            ? {
                key,
                items: out.value.items,
                next: out.value.next,
                total: out.value.total,
                estimated: out.value.totalEstimated,
                notice: out.value.notice,
                status: "ready"
              }
            : { key, items: [], next: null, status: "failed", problem: out.problem }
        )
      })
    }, delay)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [key, attempt, fetchPage])
  useEffect(() => () => inFlight.current?.abort(), [])
  const current = results !== null && results.key === key ? results : null
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
      if (out === null) return
      setResults((r) => {
        if (r === null || r.key !== current.key) return r
        if (!out.ok) return { ...r, status: "more-failed", problem: out.problem }
        const previous = out.value.reset ? [] : r.items
        const seen = new Set(previous.map((i) => i.remoteId))
        return {
          ...r,
          items: [...previous, ...out.value.items.filter((i) => !seen.has(i.remoteId))],
          next: out.value.next,
          total: out.value.total ?? r.total,
          estimated: out.value.totalEstimated ?? r.estimated,
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

const isRange = (value: SourceFilterValue | undefined): value is { readonly min?: number; readonly max?: number } =>
  typeof value === "object" && !Array.isArray(value)

/** What a source option shows once open: its reported total, "~" when it's an estimate. */
const totalLabel = (results: Results | null) =>
  results?.total === undefined ? null : `${results.estimated ? "~" : ""}${numberFormat.format(results.total)}`

/** How many filters are set, for the Filters button: tags, and the filters away from their default. */
const filterCount = (query: SourceQuery | null, caps: SourceCapabilities | undefined) =>
  query === null
    ? 0
    : query.tags.length +
      query.excludeTags.length +
      Object.entries(query.filters).filter(
        ([id, value]) => value !== false && !(caps?.ratings?.filterId === id && value === caps.ratings.default)
      ).length

const requirementMet = (filter: SourceFilter, filters: SourceQuery["filters"]) => {
  if (filter.kind !== "toggle" || !filter.requires) return true
  const chosen = filters[filter.requires.filterId]
  const values = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : []
  return values.length === filter.requires.values.length && filter.requires.values.every((v) => values.includes(v))
}

/**
 * Everything a place (home, the sidebar) needs while a source may be shown: the sources Show
 * offers, and for the one open, its capabilities, results and the controls' state.
 */
export function useSourceBrowse(source: string | null, remote: RemoteBrowse, onRemote: (remote: RemoteBrowse) => void) {
  const sources = useEnabledSources()
  const info = sources.find((s) => s.id === source) ?? null
  const sourceId = info?.id ?? null
  const { caps, problem: capsProblem, retry: retryCaps } = useCapabilities(sourceId)
  const query = caps && info ? queryOf(caps, info, remote) : null
  const { results, more, retry, waitMs } = useResults(sourceId, query)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const action = useAction()
  const change = (next: Partial<RemoteBrowse>) => {
    const merged = { ...remote, ...next }
    if (next.filters) {
      const filters = { ...next.filters }
      for (const filter of caps?.filters ?? []) if (!requirementMet(filter, filters)) delete filters[filter.id]
      merged.filters = filters
    }
    onRemote(merged)
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
export function SourceSortControl({ browse, compact = false }: { browse: SourceBrowse; compact?: boolean }) {
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
    <div className="flex shrink-0 items-center gap-1">
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
        <Segmented
          label="Sort by"
          value={current?.id ?? null}
          onValueChange={(sort) => browse.change({ sort, reverse: false })}
          options={sorts.map((s) => ({
            value: s.id,
            label: s.label,
            description: `Sorts ${name}'s cards by ${s.label.toLowerCase()}.`
          }))}
        />
      )}
      {direction}
    </div>
  )
}

/** Filters: the last control of the sort row, only while a source is shown (§3.2). */
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
    <Tooltip
      label={
        browse.filtersOpen
          ? "Click to hide the filters"
          : `Click to show every filter ${browse.info?.name ?? ""} offers`
      }
    >
      <Button
        variant="ghost"
        className={`h-8 gap-1 px-2 ${pressedButtonClass}`}
        aria-pressed={browse.filtersOpen}
        aria-expanded={browse.filtersOpen}
        aria-controls={panelId}
        {...(compact ? { "aria-label": count > 0 ? `Filters: ${count} set` : "Filters" } : {})}
        onClick={() => browse.setFiltersOpen(!browse.filtersOpen)}
      >
        <Icon name="sliders" />
        {!compact && "Filters"}
        {count > 0 && <span className="text-muted tabular-nums">{count}</span>}
      </Button>
    </Tooltip>
  )
}

/** A filter's label, with its explanation in a "?" beside it (the field rule). */
function FilterLabel({ filter, id }: { filter: SourceFilter; id?: string }) {
  return (
    <div className="text-sm leading-5">
      <span id={id} className="font-medium">
        {filter.label}
      </span>
      {filter.about && (
        <>
          {" "}
          <AboutHint heading={filter.label}>{filter.about}</AboutHint>
        </>
      )}
    </div>
  )
}

function RangeFilter({
  filter,
  value,
  onChange
}: {
  filter: Extract<SourceFilter, { kind: "range" }>
  value: { readonly min?: number; readonly max?: number } | undefined
  onChange: (value: { min?: number; max?: number } | undefined) => void
}) {
  const id = useId()
  const set = (side: "min" | "max", text: string) => {
    const number = text.trim() === "" ? undefined : Number(text)
    if (number !== undefined && !Number.isFinite(number)) return
    const next = { ...value, [side]: number }
    if (next.min === undefined) delete next.min
    if (next.max === undefined) delete next.max
    onChange(next.min === undefined && next.max === undefined ? undefined : next)
  }
  const unit = filter.unit ? ` (${filter.unit})` : ""
  return (
    <div role="group" aria-labelledby={id} className="flex min-w-0 flex-col gap-1.5">
      <FilterLabel filter={filter} id={id} />
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          aria-label={`${filter.label}: at least${unit}`}
          placeholder={filter.min === undefined ? "Min" : `Min ${filter.min}`}
          value={value?.min ?? ""}
          onChange={(event) => set("min", event.currentTarget.value)}
        />
        <span aria-hidden="true" className="text-muted">
          –
        </span>
        <Input
          type="number"
          inputMode="numeric"
          aria-label={`${filter.label}: at most${unit}`}
          placeholder={filter.max === undefined ? "Max" : `Max ${filter.max}`}
          value={value?.max ?? ""}
          onChange={(event) => set("max", event.currentTarget.value)}
        />
      </div>
    </div>
  )
}

/** The tag field: typing suggests the source's tags with their counts; Enter adds what's typed. */
function TagField({ browse }: { browse: SourceBrowse }) {
  const call = useSourceCall()
  const [text, setText] = useState("")
  const [suggestions, setSuggestions] = useState<ReadonlyArray<{ tag: string; label?: string; count?: number }>>([])
  const suggest = browse.caps?.tags.suggest === true
  const sourceId = browse.info?.id ?? null
  const prefix = text.trim()
  useEffect(() => {
    if (!suggest || sourceId === null || prefix === "") return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void call((client) => client("SourceTags", { sourceId, prefix }), controller.signal).then((out) => {
        if (out?.ok) setSuggestions(out.value.slice(0, 12))
      })
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `call` is a fresh closure each render
  }, [suggest, sourceId, prefix])
  const add = (tag: string) => {
    const clean = tag.trim()
    if (clean === "" || browse.remote.tags.includes(clean)) return
    browse.change({
      tags: [...browse.remote.tags, clean],
      excludeTags: browse.remote.excludeTags.filter((t) => t !== clean)
    })
    setText("")
    setSuggestions([])
  }
  const shown = prefix === "" ? [] : suggestions.filter((s) => s.tag.toLowerCase().startsWith(prefix.toLowerCase()))
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Field
        label="Tags"
        about="Adds a tag the cards must have. Click its chip to exclude it instead, and again to remove it."
      >
        <Input
          value={text}
          placeholder="Add a tag"
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              add(text)
            }
          }}
        />
      </Field>
      {shown.length > 0 && (
        <div aria-label="Suggested tags" className="flex flex-wrap gap-1">
          {shown.map((s) => (
            <Button
              key={s.tag}
              variant="ghost"
              className="h-7 px-2 text-xs"
              hint={`Adds the ${s.tag} tag.`}
              onClick={() => add(s.tag)}
            >
              {s.label ?? s.tag}
              {s.count !== undefined && <span className="text-muted tabular-nums">{numberFormat.format(s.count)}</span>}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Every criterion the source offers, generated from its capabilities (§2.3). */
export function SourceFiltersPanel({ browse, id }: { browse: SourceBrowse; id: string }) {
  const caps = browse.caps
  if (!browse.filtersOpen || !caps) return null
  const filters = browse.query?.filters ?? {}
  const set = (filterId: string, value: SourceFilterValue | undefined) => {
    const next = { ...browse.remote.filters }
    if (value === undefined) delete next[filterId]
    else next[filterId] = value
    browse.change({ filters: next })
  }
  return (
    <InlinePanel id={id} title={`${browse.info?.name ?? ""} filters`} onClose={() => browse.setFiltersOpen(false)}>
      <div className="grid min-w-0 gap-4 @xl:grid-cols-2">
        {(caps.tags.include || caps.tags.exclude) && <TagField browse={browse} />}
        {caps.filters.map((filter) => {
          const value = filters[filter.id]
          switch (filter.kind) {
            case "choice":
              return (
                <div key={filter.id} className="flex min-w-0 flex-col gap-1.5">
                  <FilterLabel filter={filter} />
                  {filter.multi ? (
                    <Segmented
                      multiple
                      wrap
                      label={filter.label}
                      value={Array.isArray(value) ? value : []}
                      onValueChange={(chosen) => set(filter.id, chosen.length ? chosen : undefined)}
                      options={filter.options.map((o) => ({
                        value: o.value,
                        label: o.label,
                        description: `Filters by ${filter.label.toLowerCase()}: ${o.label.toLowerCase()}.`
                      }))}
                    />
                  ) : (
                    <Segmented
                      wrap
                      label={filter.label}
                      value={typeof value === "string" ? value : null}
                      onValueChange={(chosen) => set(filter.id, chosen)}
                      options={filter.options.map((o) => ({
                        value: o.value,
                        label: o.label,
                        description: `Filters by ${filter.label.toLowerCase()}: ${o.label.toLowerCase()}.`
                      }))}
                    />
                  )}
                </div>
              )
            case "range":
              return (
                <RangeFilter
                  key={filter.id}
                  filter={filter}
                  value={isRange(value) ? value : undefined}
                  onChange={(range) => set(filter.id, range)}
                />
              )
            case "toggle":
              return (
                <Switch
                  key={filter.id}
                  checked={value === true}
                  disabled={!requirementMet(filter, filters)}
                  onCheckedChange={(on) => set(filter.id, on ? true : undefined)}
                  hint={
                    !requirementMet(filter, filters)
                      ? filter.requires!.about
                      : value === true
                        ? `Click to stop filtering by ${filter.label.toLowerCase()}`
                        : `Click to show only cards that ${filter.label.toLowerCase().replace(/^has /, "have ")}`
                  }
                  {...(filter.about ? { about: filter.about } : {})}
                >
                  {filter.label}
                </Switch>
              )
            case "text":
              return (
                <Field key={filter.id} label={filter.label} about={filter.about}>
                  <Input
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => set(filter.id, event.currentTarget.value || undefined)}
                  />
                </Field>
              )
          }
        })}
      </div>
    </InlinePanel>
  )
}

const chipClass =
  "inline-flex h-7 min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-surface pr-0.5 pl-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus"

function Chip({
  children,
  onRemove,
  onClick,
  hint
}: {
  children: ReactNode
  onRemove: () => void
  onClick?: (() => void) | undefined
  hint?: string | undefined
}) {
  return (
    <span
      data-source-chip
      data-layout-audit-ignore="inset: A chip's remove button sits in the pill's compact end, as in MultiSelect"
      className={chipClass}
    >
      {onClick ? (
        <Tooltip label={hint ?? ""}>
          <button type="button" className="inline-flex min-w-0 items-center gap-1 outline-none" onClick={onClick}>
            <span className="truncate">{children}</span>
          </button>
        </Tooltip>
      ) : (
        <span className="min-w-0 truncate">{children}</span>
      )}
      <IconButton
        label="Remove"
        hint="Removes this filter."
        icon="close"
        className="size-6! shrink-0"
        onClick={onRemove}
      />
    </span>
  )
}

const rangeText = (label: string, range: { readonly min?: number; readonly max?: number }) =>
  range.min !== undefined && range.max !== undefined
    ? `${label} ${numberFormat.format(range.min)}–${numberFormat.format(range.max)}`
    : range.min !== undefined
      ? `${label} ≥ ${numberFormat.format(range.min)}`
      : `${label} ≤ ${numberFormat.format(range.max ?? 0)}`

/** The filters set, as chips on one line under the search; nothing at all when none are (§3.2). */
export function SourceChips({ browse }: { browse: SourceBrowse }) {
  const caps = browse.caps
  if (!caps) return null
  const { remote } = browse
  const ratings = caps.ratings
  const effective = browse.query?.filters ?? {}
  const chips: Array<ReactNode> = []
  for (const tag of remote.tags)
    chips.push(
      <Chip
        key={`+${tag}`}
        hint={`Click to exclude ${tag}`}
        onClick={
          caps.tags.exclude
            ? () =>
                browse.change({
                  tags: remote.tags.filter((t) => t !== tag),
                  excludeTags: [...remote.excludeTags, tag]
                })
            : undefined
        }
        onRemove={() => browse.change({ tags: remote.tags.filter((t) => t !== tag) })}
      >
        +{tag}
      </Chip>
    )
  for (const tag of remote.excludeTags)
    chips.push(
      <Chip
        key={`-${tag}`}
        hint={`Click to remove the ${tag} filter`}
        onClick={() => browse.change({ excludeTags: remote.excludeTags.filter((t) => t !== tag) })}
        onRemove={() => browse.change({ excludeTags: remote.excludeTags.filter((t) => t !== tag) })}
      >
        <Icon name="ban" />
        <span className="sr-only">Not </span>
        {tag}
      </Chip>
    )
  for (const filter of caps.filters) {
    const value = effective[filter.id]
    if (value === undefined) continue
    // The rating shows as a chip only when it isn't the source's own default (§5.3).
    if (ratings?.filterId === filter.id && value === ratings.default) continue
    const remove = () => {
      const next = { ...remote.filters }
      delete next[filter.id]
      if (ratings?.filterId === filter.id && ratings.default !== null) next[filter.id] = ratings.default
      browse.change({ filters: next })
    }
    const label =
      filter.kind === "toggle"
        ? filter.label
        : filter.kind === "choice"
          ? `${filter.label}: ${(Array.isArray(value) ? value : [String(value)])
              .map((v) => filter.options.find((o) => o.value === v)?.label ?? v)
              .join(", ")}`
          : filter.kind === "range" && isRange(value)
            ? rangeText(filter.label, value)
            : `${filter.label}: ${String(value)}`
    chips.push(
      <Chip key={filter.id} onRemove={remove}>
        {label}
      </Chip>
    )
  }
  if (chips.length === 0) return null
  return (
    <div aria-label="Filters set" className="flex min-w-0 flex-wrap items-center gap-1.5">
      {chips}
      <Button
        variant="ghost"
        className="h-7 px-2 text-xs"
        hint="Removes every filter."
        onClick={() => clearFilters(browse)}
      >
        Clear filters
      </Button>
    </div>
  )
}

const clearFilters = (browse: SourceBrowse) => {
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
  const href = `/sources/${encodeURIComponent(info.id)}/cards/${encodeURIComponent(card.remoteId)}/chat`
  const navigate = useNavigate()
  const ratingShown = card.rating !== undefined
  const adopt = useAdoptRemote()
  const openCharacter = useOpenCharacter()
  // The user's own card for it (§3.7): from the results, or just added here.
  const [added, setAdded] = useState<{ entityId: string; archived: boolean } | null>(null)
  const [flash, setFlash] = useState(false)
  const mine = added ?? (card.held ? { entityId: card.held.entityId, archived: card.held.archived } : null)
  const openMine = (entityId: string) => openCharacter(entityId as EntityId)
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
      <span className="truncate text-xs text-muted">{card.creator ? `by ${card.creator}` : " "}</span>
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
          mine !== null ? (
            <Tooltip label={`Opens your ${card.name}.`}>
              <Link
                to="/cards/$entityId/chat"
                params={{ entityId: mine.entityId }}
                onClick={openOnPlainClick(() => openMine(mine.entityId))}
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
          <MenuItem
            icon="person"
            description="Opens your copy, as a click does."
            onClick={() => openMine(mine.entityId)}
          >
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
        <MenuItem
          icon="external"
          description="Opens it in a new tab of the browser."
          onClick={() => window.open(href, "_blank", "noopener")}
        >
          Open in a new browser tab
        </MenuItem>
        {card.url !== undefined && (
          <MenuItem
            icon="external"
            description={`Opens this card's page on ${info.name}, in a new tab.`}
            onClick={() => window.open(card.url, "_blank", "noopener,noreferrer")}
          >
            Open on {info.name}
          </MenuItem>
        )}
        {card.creator !== undefined && (
          <MenuItem
            icon="search"
            description={`Searches ${info.name} for cards by ${card.creator}.`}
            onClick={() => byCreator(browse, card.creatorQuery ?? card.creator!)}
          >
            Search {info.name} for cards by {card.creator}
          </MenuItem>
        )}
      </ContextMenu>
    </div>
  )
}

const byCreator = (browse: SourceBrowse, creator: string) => {
  const creatorFilter = browse.caps?.filters.find((f) => f.kind === "text" && /author|creator/i.test(f.id))
  if (creatorFilter) browse.change({ filters: { ...browse.remote.filters, [creatorFilter.id]: creator } })
  else browse.change({ text: creator })
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
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && near.current(), {
      root,
      rootMargin: "0px 0px 800px 0px"
    })
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
        <ul className="flex min-w-0 gap-2 overflow-x-auto pb-1">
          {recent.map((r) => (
            <li key={r.remoteId} className="w-16 shrink-0">
              <Tooltip label={`Shows ${r.name} again.`}>
                <Link
                  {...cardLink(info.id, r.remoteId)}
                  className="flex flex-col items-center gap-1 text-center text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <Avatar
                    id={`${info.id}:${r.remoteId}`}
                    name={r.name}
                    size="xl"
                    {...(r.thumb ? { src: remoteImageUrl(info.id, r.thumb) } : {})}
                  />
                  <span className="w-full truncate">{r.name}</span>
                </Link>
              </Tooltip>
            </li>
          ))}
        </ul>
        <div>
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            hint="Empties this list. Nothing is removed from your cards."
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
  return (
    <div
      data-source-results={info.id}
      aria-busy={results?.status === "loading" || results?.status === "more"}
      className="flex min-w-0 flex-col gap-3"
    >
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
          {items.map((card) => (
            <RemoteTile key={card.remoteId} card={card} browse={browse} />
          ))}
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
