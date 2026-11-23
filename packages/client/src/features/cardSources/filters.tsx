// A card source's filter bar and the row of what's in effect (spec/CARD-SOURCES.md §3.2),
// generated from its capabilities (§2.3), laid out as the archive's public search page lays
// out its own. On a wide bar, always shown: beside the search, which parts the words are looked
// for in and how they're matched; then one button per panel (creators, sites, kind, rating,
// tokens, the dates) that says what's chosen and opens its controls, with the tag field at the
// end of that row; then the checkboxes. On a narrow one the Filters button opens the same
// panels in a sheet: the tags first, then a folding row per panel, the checkboxes, and Show
// results. Under the bar, a chip for every filter in effect, the source's own defaults too.
// Every value is in the URL as it's set, so a reload keeps it.
import type { SourceCapabilities, SourceFilter, SourceFilterValue, SourceQuery } from "@dreamspan/shared/cardSources.ts"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { AboutHint } from "../../ui/AboutHint.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Checkbox, RadioGroup } from "../../ui/Choice.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { RangeSlider } from "../../ui/Slider.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import {
  clearFilters,
  requirementMet,
  SourceFiltersButton,
  totalLabel,
  type SourceBrowse
} from "./browse.tsx"
import { problemText, type SourceProblem, useSourceCall } from "./remote.ts"

const numberFormat = new Intl.NumberFormat()
const count = (n: number) => numberFormat.format(n)

type Range = { readonly min?: number; readonly max?: number }
const isRange = (value: SourceFilterValue | undefined): value is Range =>
  typeof value === "object" && !Array.isArray(value)
type Filters = SourceQuery["filters"]
type HiddenDefault = NonNullable<SourceCapabilities["hiddenByDefault"]>[number]

/** A comma-separated list as the creator lists are written: a backslash escapes a comma. */
const splitList = (value: SourceFilterValue | undefined) =>
  typeof value === "string" && value.trim() !== ""
    ? value
        .split(/(?<!\\),/)
        .map((v) => v.replace(/\\(.)/g, "$1").trim())
        .filter(Boolean)
    : []
const joinList = (values: ReadonlyArray<string>) =>
  values.map((v) => v.replace(/\\/g, "\\\\").replace(/,/g, "\\,")).join(",")

/** Alternative tag groups as text, `a|b,c|d`: a card needs one tag of each group. */
const groupsOf = (value: SourceFilterValue | undefined) =>
  typeof value === "string"
    ? value
        .split(",")
        .map((g) => g.split("|").filter(Boolean))
        .filter((g) => g.length > 0)
    : []
const groupsText = (groups: ReadonlyArray<ReadonlyArray<string>>) =>
  groups.length ? groups.map((g) => g.join("|")).join(",") : undefined

/** Whether an `unless` entry with values (Kind is Lorebooks, say) holds: then the default is moot. */
const moot = (hidden: HiddenDefault, filters: Filters) =>
  hidden.unless.some((u) => {
    const value = filters[u.filterId]
    return u.values !== undefined && typeof value === "string" && u.values.includes(value)
  })

/** What the source leaves out by default and still does, given what's set. */
const activeDefaults = (browse: SourceBrowse) => {
  const filters = browse.remote.filters
  return (browse.caps?.hiddenByDefault ?? []).filter((d) =>
    d.unless.every((u) => {
      const value = filters[u.filterId]
      if (value === undefined) return true
      // A range lifts a default minimum only with a minimum of its own.
      if (isRange(value)) return value.min === undefined
      if (u.values === undefined) return false
      return !(typeof value === "string" && u.values.includes(value))
    })
  )
}

/** The source's tag or creator suggestions for what's typed, a page at a time. */
function useSuggestions(browse: SourceBrowse, kind: "tags" | "creators", prefix: string, enabled = true) {
  const call = useSourceCall()
  const sourceId = browse.info?.id ?? null
  const key = `${sourceId}:${kind}:${prefix}`
  const [state, setState] = useState<{
    key: string
    items: ReadonlyArray<{ value: string; label: string; count?: number }>
    next: string | null
    problem?: SourceProblem
    loading?: boolean
  }>({ key: "", items: [], next: null })
  const [attempt, setAttempt] = useState(0)
  const active = useRef<AbortController | null>(null)
  const request = (page: string | null) => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setState((old) => ({ key, items: old.key === key ? old.items : [], next: page, loading: true }))
    void call(
      (client) => client("SourceSuggestions", { sourceId: sourceId!, kind, prefix, page }),
      controller.signal
    ).then((out) => {
      if (!out || controller.signal.aborted) return
      setState((old) => {
        if (!out.ok) return { ...old, loading: false, problem: out.problem }
        const previous = page && !out.value.reset && old.key === key ? old.items : []
        const seen = new Set(previous.map((item) => item.value))
        return {
          key,
          items: [...previous, ...out.value.items.filter((item) => !seen.has(item.value))],
          next: out.value.next
        }
      })
    })
  }
  useEffect(() => {
    if (sourceId === null || !enabled) return
    const timer = setTimeout(() => request(null), 150)
    return () => {
      clearTimeout(timer)
      active.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key identifies the request; call is a fresh closure
  }, [key, enabled, attempt])
  const current = enabled && state.key === key ? state : { items: [], next: null, problem: undefined, loading: false }
  return {
    ...current,
    more: () => request(current.next),
    retry: () => (current.next ? request(current.next) : setAttempt((n) => n + 1))
  }
}

/** A list's Retry, or More while there are more. */
function MoreSuggestions({
  suggestions,
  kind
}: {
  suggestions: ReturnType<typeof useSuggestions>
  kind: "tags" | "creators"
}) {
  return suggestions.problem ? (
    <div className="text-sm text-muted">
      {problemText("the archive", suggestions.problem)}{" "}
      <Button variant="ghost" hint="Asks for these suggestions again." onClick={suggestions.retry}>
        Retry
      </Button>
    </div>
  ) : suggestions.next ? (
    <Button
      variant="ghost"
      className="h-7 self-start px-2 text-xs"
      hint={`Shows more ${kind} matching what you typed.`}
      disabled={suggestions.loading}
      onClick={suggestions.more}
    >
      More {kind}
    </Button>
  ) : null
}

// ---- The tag field ----

/** The text a tag is looked up by: what's typed, without the leading "-" that leaves it out. */
const tagText = (text: string) => text.trim().replace(/^-+\s*/, "")

interface TagSets {
  readonly tags: ReadonlyArray<string>
  readonly excludeTags: ReadonlyArray<string>
  readonly groups: ReadonlyArray<ReadonlyArray<string>>
}

/** The sets without a tag (a group left with one tag is that tag, required). */
const withoutTag = (sets: TagSets, tag: string): TagSets => {
  const groups = sets.groups.map((g) => g.filter((t) => t !== tag)).filter((g) => g.length > 0)
  return {
    tags: [...sets.tags.filter((t) => t !== tag), ...groups.filter((g) => g.length === 1).map((g) => g[0]!)],
    excludeTags: sets.excludeTags.filter((t) => t !== tag),
    groups: groups.filter((g) => g.length > 1)
  }
}

/** What "or" can join a tag to: a group of alternatives, or a required tag. */
type OrTarget = { readonly key: string; readonly label: string; readonly members: ReadonlyArray<string> }
const targetsOf = (sets: TagSets): Array<OrTarget> => [
  ...sets.groups.map((g) => ({ key: `g:${g.join("|")}`, label: g.join(" or "), members: g })),
  ...sets.tags.map((t) => ({ key: `t:${t}`, label: t, members: [t] }))
]

const stateOf = (sets: TagSets, tag: string) =>
  sets.tags.includes(tag)
    ? "include"
    : sets.excludeTags.includes(tag)
      ? "exclude"
      : sets.groups.some((g) => g.includes(tag))
        ? "any"
        : undefined

/** One suggested tag: its name and count, then +, or and −, each pressed while it's that. */
function TagRow({
  item,
  state,
  targets,
  canExclude,
  canOr,
  onPlace,
  onOr
}: {
  item: { value: string; label: string; count?: number }
  state: "include" | "exclude" | "any" | undefined
  targets: ReadonlyArray<OrTarget>
  canExclude: boolean
  canOr: boolean
  onPlace: (side: "include" | "exclude" | null) => void
  onOr: (target: OrTarget | null) => void
}) {
  const [choosing, setChoosing] = useState(false)
  const others = targets.filter((t) => !t.members.includes(item.value))
  const action =
    "inline-flex size-8 shrink-0 items-center justify-center rounded-md outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus aria-pressed:bg-surface-raised aria-pressed:ring-1 aria-pressed:ring-border"
  return (
    <li
      className="flex min-w-0 flex-wrap items-center gap-0.5"
      data-tag={item.value}
      {...(state ? { "data-state": state } : {})}
    >
      <span
        className={`min-w-0 flex-1 truncate py-1.5 pl-2 text-sm ${state === "exclude" ? "text-danger line-through decoration-1" : state ? "text-accent" : ""}`}
      >
        {item.label}
      </span>
      {item.count !== undefined && <span className="pr-1 text-xs text-muted tabular-nums">{count(item.count)}</span>}
      <Tooltip
        label={state === "include" ? `Click to stop requiring ${item.label}` : `Shows only cards tagged ${item.label}.`}
      >
        <button
          type="button"
          aria-label={state === "include" ? `Remove tag ${item.label}` : `Include tag ${item.label}`}
          aria-pressed={state === "include"}
          className={`${action} text-accent`}
          onClick={() => onPlace(state === "include" ? null : "include")}
        >
          <Icon name="plus" />
        </button>
      </Tooltip>
      {canOr && (
        <Tooltip
          label={
            state === "any"
              ? `Click to take ${item.label} out of its alternatives`
              : others.length === 0
                ? `Requires ${item.label}; the next tag added with or becomes an alternative to it.`
                : others.length === 1
                  ? `Cards tagged ${item.label} or ${others[0]!.label} both count.`
                  : `Makes ${item.label} an alternative to a tag you chose: cards with either count.`
          }
        >
          <button
            type="button"
            aria-label={
              state === "any"
                ? `Remove tag ${item.label} from its alternatives`
                : others.length === 0
                  ? `Add tag ${item.label}; the next tag added with or becomes an alternative to it`
                  : others.length === 1
                    ? `Add tag ${item.label} as an alternative to ${others[0]!.label}`
                    : `Add tag ${item.label} as an alternative to…`
            }
            aria-pressed={state === "any" || choosing}
            {...(others.length > 1 && state !== "any" ? { "aria-expanded": choosing } : {})}
            className={`${action} w-9 gap-0.5 text-xs font-semibold text-accent`}
            onClick={() => {
              if (state === "any") onPlace(null)
              else if (others.length > 1) setChoosing(!choosing)
              else onOr(others[0] ?? null)
            }}
          >
            or
            {others.length > 1 && state !== "any" && <Icon name="down" className={choosing ? "rotate-180" : ""} />}
          </button>
        </Tooltip>
      )}
      {canExclude && (
        <Tooltip
          label={
            state === "exclude" ? `Click to stop leaving out ${item.label}` : `Leaves out cards tagged ${item.label}.`
          }
        >
          <button
            type="button"
            aria-label={state === "exclude" ? `Remove tag ${item.label}` : `Exclude tag ${item.label}`}
            aria-pressed={state === "exclude"}
            className={`${action} text-danger`}
            onClick={() => onPlace(state === "exclude" ? null : "exclude")}
          >
            <Icon name="minus" />
          </button>
        </Tooltip>
      )}
      {choosing && (
        <div
          role="group"
          aria-label={`Add ${item.label} as an alternative to`}
          className="flex basis-full flex-wrap items-center gap-1 pb-1.5 pl-2"
        >
          <span className="mr-0.5 text-xs text-muted">or with</span>
          {others.map((target) => (
            <button
              key={target.key}
              type="button"
              aria-label={`Add tag ${item.label} as an alternative to ${target.label}`}
              onClick={() => {
                setChoosing(false)
                onOr(target)
              }}
              className="inline-flex h-7 max-w-full min-w-0 items-center rounded-full border border-accent/50 px-2.5 text-xs text-accent outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span className="truncate">{target.label}</span>
            </button>
          ))}
        </div>
      )}
    </li>
  )
}

/**
 * The tag field: Enter requires the tag typed, or leaves it out when it starts with "-". While
 * it's in use, the source's tags matching it are listed with their counts (the most used ones
 * when it's empty), each with + (require), or (an alternative to a tag chosen) and − (leave
 * out). The list stays open as tags are added; under it, what's chosen, each removable.
 */
function TagInput({ browse, inline = false }: { browse: SourceBrowse; inline?: boolean }) {
  const [text, setText] = useState("")
  const [open, setOpen] = useState(false)
  const caps = browse.caps!
  const canExclude = caps.tags.exclude
  const anyId = caps.tags.anyFilterId
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      if (!box.current?.contains(event.target as Node | null)) setOpen(false)
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("focusin", outside)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("focusin", outside)
    }
  }, [open])
  const suggestions = useSuggestions(browse, "tags", tagText(text), caps.tags.suggest && open)
  const sets: TagSets = {
    tags: browse.remote.tags,
    excludeTags: browse.remote.excludeTags,
    groups: anyId ? groupsOf(browse.remote.filters[anyId]) : []
  }
  const write = (next: TagSets) => {
    const filters = { ...browse.remote.filters }
    if (anyId) {
      const value = groupsText(next.groups)
      if (value === undefined) delete filters[anyId]
      else filters[anyId] = value
    }
    browse.change({ tags: [...next.tags], excludeTags: [...next.excludeTags], filters })
  }
  const place = (tag: string, side: "include" | "exclude" | null) => {
    const clean = tag.trim()
    if (clean === "") return
    const rest = withoutTag(sets, clean)
    if (side === "include") write({ ...rest, tags: [...rest.tags, clean] })
    else if (side === "exclude") write({ ...rest, excludeTags: [...rest.excludeTags, clean] })
    else write(rest)
  }
  const or = (tag: string, target: OrTarget | null) => {
    if (target === null) return place(tag, "include")
    const rest = withoutTag(sets, tag)
    const tags = rest.tags.filter((t) => !target.members.includes(t))
    const groups = rest.groups.filter((g) => g.join("|") !== target.members.join("|"))
    write({ ...rest, tags, groups: [...groups, [...target.members, tag]] })
  }
  const targets = targetsOf(sets)
  const shown = open
  const list = (
    <div
      className={
        inline
          ? "flex min-w-0 flex-col gap-1"
          : "absolute top-full right-0 left-0 z-20 mt-1 flex max-h-96 min-w-72 flex-col gap-1 overflow-y-auto rounded-md border border-border bg-surface p-2 shadow-lg"
      }
      {...(inline ? {} : { "data-layout-overlay": "Tag suggestions float under the tag field" })}
    >
      <ul aria-label="Suggested tags" className="flex min-w-0 flex-col">
        {suggestions.items.map((item) => (
          <TagRow
            key={item.value}
            item={item}
            state={stateOf(sets, item.value)}
            targets={targets}
            canExclude={canExclude}
            canOr={anyId !== undefined}
            onPlace={(side) => place(item.value, side)}
            onOr={(target) => or(item.value, target)}
          />
        ))}
      </ul>
      {tagText(text) !== "" && suggestions.items.length === 0 && !suggestions.loading && !suggestions.problem && (
        <p className="px-2 text-sm text-muted">No tags match</p>
      )}
      <MoreSuggestions suggestions={suggestions} kind="tags" />
      <ChosenTags sets={sets} onRemove={(tag) => place(tag, null)} />
    </div>
  )
  return (
    <div ref={box} className="relative flex min-w-0 flex-col gap-1.5" onFocus={() => setOpen(true)}>
      <Field
        label="Tags"
        labelHidden={!inline}
        aboutInfo
        about={[
          "Type to find a tag. Enter or + requires it; − or a leading - leaves it out.",
          anyId ? "or makes it an alternative to a tag you required: cards with either count." : ""
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <Input
          value={text}
          placeholder={canExclude ? "Add tag… (−tag excludes)" : "Add tag…"}
          onChange={(event) => {
            setText(event.currentTarget.value)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              place(tagText(text), canExclude && text.trimStart().startsWith("-") ? "exclude" : "include")
              setText("")
            } else if (event.key === "Escape" && open) {
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
            }
          }}
        />
      </Field>
      {shown && list}
    </div>
  )
}

/** What's chosen, under the tag list: required tags, groups of alternatives, tags left out. */
function ChosenTags({ sets, onRemove }: { sets: TagSets; onRemove: (tag: string) => void }) {
  if (sets.tags.length + sets.excludeTags.length + sets.groups.length === 0) return null
  const remove = (tag: string, side: string) => (
    <IconButton
      label={`Remove ${side} tag ${tag}`}
      hint="Takes this tag out of the filter."
      icon="close"
      className="size-6! shrink-0"
      onClick={() => onRemove(tag)}
    />
  )
  return (
    <ul
      aria-label="Chosen tags"
      data-layout-audit-ignore="inset: A chip's remove button sits in the pill's compact end, as in MultiSelect"
      className="flex flex-wrap gap-1.5 border-t border-border pt-2"
    >
      {sets.tags.map((t) => (
        <li key={`t:${t}`} className={`${chipClass} border-accent/60`}>
          <span aria-hidden="true" className="text-accent">
            +
          </span>
          <span className="min-w-0 truncate">{t}</span>
          {remove(t, "included")}
        </li>
      ))}
      {sets.groups.map((g) => (
        <li key={`g:${g.join("|")}`} className={`${chipClass} h-auto! flex-wrap rounded-2xl! border-accent/60 py-0.5`}>
          <span className="text-muted">Any of</span>
          {g.map((t, i) => (
            <span key={t} className="inline-flex min-w-0 items-center">
              {i > 0 && <span className="mr-1 text-muted">or</span>}
              <span className="min-w-0 truncate">{t}</span>
              {remove(t, "alternative")}
            </span>
          ))}
        </li>
      ))}
      {sets.excludeTags.map((t) => (
        <li key={`n:${t}`} className={`${chipClass} border-danger/60 text-danger`}>
          <span aria-hidden="true">−</span>
          <span className="min-w-0 truncate line-through decoration-1">{t}</span>
          {remove(t, "excluded")}
        </li>
      ))}
    </ul>
  )
}

// ---- The panels ----

type Patch = Record<string, SourceFilterValue | undefined>
type SetFilters = (patch: Patch) => void

/** One panel: criteria sharing a group, named by it. */
interface Panel {
  readonly key: string
  readonly title: string
  readonly filters: Array<SourceFilter>
}

/** The panels the bar has a control for, in the archive's order; any other group renders nothing. */
const PANEL_KEYS = ["Creators", "Sites", "Kind", "Rating", "Tokens", "Added", "Created"]

/** The bar from the capabilities: the panels, the checkboxes, and what sits by the search. */
const layoutOf = (caps: SourceCapabilities) => {
  const panels: Array<Panel> = []
  const switches: Array<SourceFilter> = []
  const search: Array<SourceFilter> = []
  for (const filter of caps.filters) {
    if (filter.place === "none" || filter.id === caps.tags.anyFilterId) continue
    if (filter.place === "search") search.push(filter)
    else if (filter.place === "switches" && filter.kind === "toggle") switches.push(filter)
    else if (filter.place === "switches" && caps.hiddenByDefault?.some((d) => d.filterId === filter.id && d.toggle))
      switches.push(filter)
    else if (!filter.group || !PANEL_KEYS.includes(filter.group)) {
      // A parameter with no control of its own renders nothing, never a button of its own.
      if (import.meta.env.DEV) console.warn(`card source filter with no control, left out: ${filter.id}`)
    } else {
      const key = filter.group
      const found = panels.find((p) => p.key === key)
      if (found) found.filters.push(filter)
      else panels.push({ key, title: filter.group, filters: [filter] })
    }
  }
  return { panels, switches, search }
}

/** The creator filters, when the source lists creators with their cards: one picker. */
const creatorIds = (caps: SourceCapabilities) => {
  const c = caps.creators
  if (!c) return []
  const ids = [c.filterId, c.anyFilterId, c.excludeFilterId].filter((id) => id !== undefined)
  const listed = caps.filters.some((f) => ids.includes(f.id) && f.kind === "text" && f.suggestions?.kind === "creators")
  return listed ? ids : []
}

const isDatePair = (panel: Panel) =>
  panel.filters.length === 2 && panel.filters.every((f) => f.kind === "text" && f.format === "date")

/** A range as words: "≥ 300 tokens", "100–2,000 tokens", "Any tokens". */
const rangeWords = (min: number, max: number | undefined, unit: string) =>
  min === 0 && max === undefined
    ? `Any ${unit}`.trim()
    : max === undefined
      ? `≥ ${count(min)} ${unit}`.trim()
      : min === 0
        ? `≤ ${count(max)} ${unit}`.trim()
        : `${count(min)}–${count(max)} ${unit}`.trim()

const dateWords = (word: string, from: string, until: string) =>
  !from && !until
    ? `${word}: any date`
    : !until
      ? `${word} from ${from}`
      : !from
        ? `${word} until ${until}`
        : `${word} ${from} – ${until}`

const handle = (identity: string) => identity.slice(identity.indexOf("/") + 1)

/** The creators chosen and whether they're left out. */
const creatorChoice = (caps: SourceCapabilities, filters: Filters) => {
  const c = caps.creators!
  const not = c.excludeFilterId ? splitList(filters[c.excludeFilterId]) : []
  const by = [...splitList(filters[c.filterId]), ...(c.anyFilterId ? splitList(filters[c.anyFilterId]) : [])]
  return not.length ? { mode: "not" as const, chosen: not } : { mode: "by" as const, chosen: by }
}

/** The floor the source applies to a range while nothing lifts it. */
const floorOf = (browse: SourceBrowse, filter: SourceFilter) =>
  activeDefaults(browse).find((d) => d.filterId === filter.id)?.min

/** What a panel's button says: what's chosen in it. */
const summaryOf = (browse: SourceBrowse, panel: Panel): string => {
  const caps = browse.caps!
  const filters = browse.remote.filters
  const first = panel.filters[0]!
  const text = (id: string | undefined) => (id && typeof filters[id] === "string" ? (filters[id] as string) : "")
  const list = (id: string | undefined) => {
    const value = id ? filters[id] : undefined
    return Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  }
  const labelOf = (value: string) =>
    (first.kind === "choice" ? first.options.find((o) => o.value === value)?.label : undefined) ?? value
  const exclude = first.kind === "choice" ? first.excludeId : undefined
  switch (panel.key) {
    case "Creators": {
      const { mode, chosen } = creatorChoice(caps, filters)
      if (chosen.length === 0) return "Any creator"
      if (mode === "not") return `Not by ${chosen.length} ${chosen.length === 1 ? "creator" : "creators"}`
      return chosen.length === 1 ? "By 1 creator" : `Any of ${chosen.length} creators`
    }
    case "Sites": {
      const names = (values: ReadonlyArray<string>) =>
        values.length <= 2
          ? values.map((v) => labelOf(v)).join(", ")
          : `${values.length} sites`
      const shown = [
        list(first.id).length ? names(list(first.id)) : "",
        list(exclude).length ? `Exclude ${names(list(exclude))}` : ""
      ].filter(Boolean)
      return shown.length ? shown.join("; ") : "All sites"
    }
    case "Kind": {
      const value = text(first.id)
      return value && value !== "both" ? labelOf(value) : "All kinds"
    }
    case "Rating": {
      const value = text(first.id) || caps.ratings?.default || "include"
      return value === "exclude" ? "NSFW hidden" : value === "only" ? "NSFW only" : "NSFW included"
    }
    case "Tokens": {
      const value = filters[first.id]
      const range = isRange(value) ? value : {}
      return rangeWords(range.min ?? floorOf(browse, first) ?? 0, range.max, "tokens")
    }
    case "Added":
    case "Created":
      return dateWords(panel.key, text(first.id), text(panel.filters[1]?.id))
    default:
      return ""
  }
}

/** Two dates, from and to, with Clear; each applies as soon as it's a whole date. */
function DatePanel({ panel, filters, set }: { panel: Panel; filters: Filters; set: SetFilters }) {
  const [from, until] = panel.filters as [SourceFilter, SourceFilter]
  const value = (f: SourceFilter) => {
    const v = filters[f.id]
    return typeof v === "string" ? v : ""
  }
  const any = value(from) !== "" || value(until) !== ""
  return (
    <div className="flex items-end gap-2" data-date-range={panel.key}>
      {[from, until].map((filter, i) => (
        <Field
          key={filter.id}
          // Shown as From and To; named in full ("Added after"), since a sheet holds two pairs.
          label={
            <>
              <span aria-hidden="true">{i === 0 ? "From" : "To"}</span>
              <span className="sr-only">{filter.label}</span>
            </>
          }
          about={filter.about}
          aboutLabel={filter.label}
          className="min-w-0 flex-1"
        >
          <Input
            type="date"
            data-date-filter={filter.id}
            value={value(filter)}
            onChange={(event) => set({ [filter.id]: event.currentTarget.value || undefined })}
          />
        </Field>
      ))}
      <IconButton
        label="Clear the dates"
        hint="Clears both dates."
        icon="close"
        disabled={!any}
        className={`size-9! shrink-0 rounded-md border border-border ${any ? "" : "invisible"}`}
        onClick={() => set({ [from.id]: undefined, [until.id]: undefined })}
      />
    </div>
  )
}

/** The slider's positions: 0 to `STEPS`, on a log scale up to its top value. */
const STEPS = 1000
/** Two significant digits from 100 up, whole numbers below. */
const round = (n: number) => {
  if (n < 100) return Math.round(n)
  const unit = 10 ** (Math.floor(Math.log10(n)) - 1)
  return Math.round(n / unit) * unit
}
const scaleOf = (top: number) => {
  const span = Math.log10(top + 1)
  return {
    valueAt: (position: number) =>
      position <= 0 ? 0 : position >= STEPS ? top : Math.min(top, round(10 ** ((position / STEPS) * span) - 1)),
    positionOf: (value: number) =>
      value <= 0 ? 0 : value >= top ? STEPS : Math.round((Math.log10(value + 1) / span) * STEPS)
  }
}

/**
 * A range: a slider on a log scale with a thumb per end (the right end is "no maximum"), both
 * ends read out under it, and the same range as typed fields, with Clear and Reset to the
 * source's default. A default minimum shows as the low end.
 */
function RangePanel({
  filter,
  browse,
  set
}: {
  filter: Extract<SourceFilter, { kind: "range" }>
  browse: SourceBrowse
  set: SetFilters
}) {
  const raw = browse.remote.filters[filter.id]
  const value = isRange(raw) ? raw : undefined
  const floor = floorOf(browse, filter)
  const min = value?.min ?? floor ?? 0
  const max = value?.max
  const unit = filter.unit ?? ""
  const scale = scaleOf(filter.scaleMax ?? filter.max ?? 100_000)
  const committed: [number, number] = [scale.positionOf(min), max === undefined ? STEPS : scale.positionOf(max)]
  const [drag, setDrag] = useState<[number, number] | null>(null)
  const shown = drag ?? committed
  const words = (n: number) => `${count(n)} ${unit}`.trim()
  const text = (position: number, thumb: 0 | 1) => {
    // An untouched thumb says its exact value, not the scale's nearest step.
    if (position === committed[thumb]) return thumb === 0 ? words(min) : max === undefined ? "No maximum" : words(max)
    if (thumb === 1 && position >= STEPS) return "No maximum"
    return words(scale.valueAt(position))
  }
  const write = (next: { min?: number | undefined; max?: number | undefined } | undefined) => {
    if (next && next.min !== undefined && next.max !== undefined && next.min > next.max)
      next = { min: next.max, max: next.min }
    const clean: { min?: number; max?: number } = {}
    if (next?.min !== undefined) clean.min = next.min
    if (next?.max !== undefined) clean.max = next.max
    set({ [filter.id]: clean.min === undefined && clean.max === undefined ? undefined : clean })
  }
  const typed = (side: "min" | "max", text: string) => {
    const number = text.trim() === "" ? undefined : Number(text)
    if (number !== undefined && (!Number.isFinite(number) || number < 0)) return
    // An empty minimum is no minimum: 0, which lifts a default one.
    write({ ...value, [side]: side === "min" && number === undefined && floor !== undefined ? 0 : number })
  }
  const atDefault = value === undefined
  const resetLabel = atDefault
    ? `The ${filter.label.toLowerCase()} range is the default`
    : floor !== undefined || browse.caps?.hiddenByDefault?.some((d) => d.filterId === filter.id)
      ? `Reset the ${filter.label.toLowerCase()} range to the default`
      : `Reset the ${filter.label.toLowerCase()} range`
  return (
    <div className="flex w-80 max-w-full flex-col gap-3" data-range-filter={filter.id}>
      <div className="flex flex-col gap-1">
        <RangeSlider
          label={filter.label}
          thumbLabels={[`Min ${unit}`.trim(), `Max ${unit}`.trim()]}
          value={shown}
          steps={STEPS}
          valueText={text}
          onValueChange={setDrag}
          onValueCommitted={([a, b]) => {
            setDrag(null)
            if (a === committed[0] && b === committed[1]) return
            // A thumb that didn't move keeps its exact value.
            const low = a === committed[0] ? value?.min : scale.valueAt(a)
            const high = b === committed[1] ? max : b >= STEPS ? undefined : scale.valueAt(b)
            write({ min: low, max: high })
          }}
        />
        <p aria-hidden="true" className="flex justify-between text-sm text-muted tabular-nums">
          <span>{text(shown[0], 0)}</span>
          <span>{text(shown[1], 1)}</span>
        </p>
      </div>
      <div className="flex items-end gap-2">
        <Field label={`Min ${unit}`.trim()} className="w-28">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            value={String(min)}
            onChange={(e) => typed("min", e.currentTarget.value)}
          />
        </Field>
        <Field label={`Max ${unit}`.trim()} className="w-28">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            value={max === undefined ? "" : String(max)}
            onChange={(e) => typed("max", e.currentTarget.value)}
          />
        </Field>
        <IconButton
          label={`Clear the ${filter.label.toLowerCase()} range`}
          hint={`Any ${unit || "value"}: no minimum, no maximum.`}
          icon="close"
          disabled={min === 0 && max === undefined}
          className={`size-9! shrink-0 rounded-md border border-border ${min === 0 && max === undefined ? "invisible" : ""}`}
          onClick={() =>
            write(
              floor !== undefined || browse.caps?.hiddenByDefault?.some((d) => d.filterId === filter.id)
                ? { min: 0 }
                : undefined
            )
          }
        />
        <IconButton
          label={resetLabel}
          hint={resetLabel}
          icon="undo"
          disabled={atDefault}
          className="size-9! shrink-0 rounded-md border border-border disabled:opacity-40"
          onClick={() => write(undefined)}
        />
      </div>
    </div>
  )
}

/** A heading for a radio group, which needs a visible label to name it. */
function GroupHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} className="sr-only">
      {children}
    </span>
  )
}

/** One choice: radio buttons. */
function ChoicePanel({
  filter,
  filters,
  set,
  browse
}: {
  filter: Extract<SourceFilter, { kind: "choice" }>
  filters: Filters
  set: SetFilters
  browse: SourceBrowse
}) {
  const id = useId()
  const value = filters[filter.id]
  const first = filter.options[0]?.value ?? ""
  const ratings = browse.caps?.ratings
  const current =
    typeof value === "string" ? value : ratings?.filterId === filter.id && ratings.default ? ratings.default : first
  return (
    <div className="flex flex-col gap-2">
      <GroupHeading id={id}>{filter.label}</GroupHeading>
      <RadioGroup
        aria-labelledby={id}
        value={current}
        onValueChange={(next) =>
          set({ [filter.id]: next === first && !(ratings?.filterId === filter.id) ? undefined : next })
        }
        options={filter.options.map((o) => ({ value: o.value, label: o.label }))}
      />
    </div>
  )
}

/** Several choices: checkboxes. */
function ChecksPanel({
  filter,
  filters,
  set
}: {
  filter: Extract<SourceFilter, { kind: "choice" }>
  filters: Filters
  set: SetFilters
}) {
  const value = filters[filter.id]
  const chosen = Array.isArray(value) ? value : []
  return (
    <div role="group" aria-label={filter.label} className="flex flex-col gap-2.5">
      {filter.options.map((o) => (
        <Checkbox
          key={o.value}
          checked={chosen.includes(o.value)}
          onCheckedChange={(on) => {
            const next = on ? [...chosen, o.value] : chosen.filter((v) => v !== o.value)
            set({ [filter.id]: next.length ? next : undefined })
          }}
        >
          {o.label}
        </Checkbox>
      ))}
    </div>
  )
}

/** A list of options, included or excluded as a whole (Include / Exclude above), and the panel's switches. */
function IncludeExcludePanel({ panel, browse, set }: { panel: Panel; browse: SourceBrowse; set: SetFilters }) {
  const id = useId()
  const filter = panel.filters[0] as Extract<SourceFilter, { kind: "choice" }>
  const exclude = panel.filters.find((f) => f.id === filter.excludeId)!
  const filters = browse.remote.filters
  const list = (fid: string) => {
    const v = filters[fid]
    return Array.isArray(v) ? v : []
  }
  const [picked, setPicked] = useState<"include" | "exclude">("include")
  const mode = list(exclude.id).length ? "exclude" : list(filter.id).length ? "include" : picked
  const chosen = mode === "exclude" ? list(exclude.id) : list(filter.id)
  const writeList = (next: "include" | "exclude", values: ReadonlyArray<string>) =>
    set({
      [filter.id]: next === "include" && values.length ? [...values] : undefined,
      [exclude.id]: next === "exclude" && values.length ? [...values] : undefined
    })
  const toggles = panel.filters.filter((f) => f.kind === "toggle")
  return (
    <fieldset className="flex flex-col gap-3" data-filter-list={filter.id}>
      <legend className="sr-only">{panel.title}</legend>
      <GroupHeading id={id}>{`${panel.title} mode`}</GroupHeading>
      <RadioGroup
        aria-labelledby={id}
        value={mode}
        onValueChange={(next) => {
          setPicked(next)
          if (chosen.length) writeList(next, chosen)
        }}
        options={[
          { value: "include", label: "Include", hint: `Only cards on the ${panel.title.toLowerCase()} ticked.` },
          { value: "exclude", label: "Exclude", hint: `Leaves out cards on the ${panel.title.toLowerCase()} ticked.` }
        ]}
      />
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {filter.options.map((o) => (
          <Checkbox
            key={o.value}
            checked={chosen.includes(o.value)}
            onCheckedChange={(on) => {
              setPicked(mode)
              writeList(mode, on ? [...chosen, o.value] : chosen.filter((v) => v !== o.value))
            }}
          >
            {o.label}
          </Checkbox>
        ))}
      </div>
      {toggles.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border pt-2">
          {toggles.map((t) => (
            <ToggleBox key={t.id} filter={t} filters={filters} set={set} />
          ))}
        </div>
      )}
      {chosen.length > 0 && (
        <Button
          variant="ghost"
          className="self-start"
          hint="Shows cards from every site."
          onClick={() => writeList("include", [])}
        >
          All sites
        </Button>
      )}
    </fieldset>
  )
}

/** A switch, as a checkbox; one that needs another choice is disabled with the reason until then. */
function ToggleBox({ filter, filters, set }: { filter: SourceFilter; filters: Filters; set: SetFilters }) {
  if (filter.kind !== "toggle") return null
  const met = requirementMet(filter, filters)
  const box = (
    <Checkbox
      checked={filters[filter.id] === true}
      disabled={!met}
      {...(filter.about && met
        ? {
            labelHelp: (
              <AboutHint heading={filter.label} info>
                {filter.about}
              </AboutHint>
            )
          }
        : {})}
      onCheckedChange={(on) => set({ [filter.id]: on ? true : undefined })}
    >
      {filter.label}
    </Checkbox>
  )
  return met || !filter.requires ? (
    box
  ) : (
    <Tooltip label={filter.requires.about}>{<span className="inline-flex">{box}</span>}</Tooltip>
  )
}

/** The creators the source lists, with their cards' counts: by any of them, or not by any of them. */
function CreatorsPanel({ browse, set }: { browse: SourceBrowse; set: SetFilters }) {
  const caps = browse.caps!
  const c = caps.creators!
  const id = useId()
  const filters = browse.remote.filters
  const current = creatorChoice(caps, filters)
  const [picked, setPicked] = useState<"by" | "not">("by")
  const mode = current.chosen.length ? current.mode : picked
  const chosen = current.chosen
  const [text, setText] = useState("")
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map())
  const suggestions = useSuggestions(browse, "creators", text.trim())
  const full = chosen.length >= 20
  const write = (next: "by" | "not", list: ReadonlyArray<string>) => {
    const patch: Record<string, SourceFilterValue | undefined> = { [c.filterId]: undefined }
    if (c.anyFilterId) patch[c.anyFilterId] = undefined
    if (c.excludeFilterId) patch[c.excludeFilterId] = undefined
    if (list.length && next === "not" && c.excludeFilterId) patch[c.excludeFilterId] = joinList(list)
    else if (list.length === 1 || (list.length && !c.anyFilterId)) patch[c.filterId] = list[0]!
    else if (list.length && c.anyFilterId) patch[c.anyFilterId] = joinList(list)
    set(patch)
  }
  const nameOf = (identity: string) => names.get(identity) ?? handle(identity)
  // A creator's site, named as the site picker names it.
  const siteName = (site: string) =>
    caps.filters.flatMap((f) => (f.kind === "choice" && f.excludeId ? f.options : [])).find((o) => o.value === site)
      ?.label ?? site
  return (
    <div className="flex w-96 max-w-full min-h-0 flex-col gap-2" data-creator-picker>
      {c.excludeFilterId && (
        <>
          <GroupHeading id={id}>Creator mode</GroupHeading>
          <RadioGroup
            aria-labelledby={id}
            value={mode}
            onValueChange={(next) => {
              setPicked(next)
              if (chosen.length) write(next, chosen)
            }}
            options={[
              { value: "by", label: "By any of", hint: "Only cards by one of the creators ticked." },
              { value: "not", label: "Not by any of", hint: "Leaves out the cards of the creators ticked." }
            ]}
          />
        </>
      )}
      <Field label={mode === "not" ? "Creator to leave out" : "Add a creator"} labelHidden>
        <Input
          type="search"
          value={text}
          placeholder={
            mode === "not" ? "Creator to leave out…" : chosen.length ? "Add another creator…" : "Add a creator…"
          }
          onChange={(event) => setText(event.currentTarget.value)}
        />
      </Field>
      <ul aria-label="Creators" className="-mx-2 flex max-h-80 min-w-0 flex-col overflow-y-auto px-2">
        {suggestions.items.map((item) => {
          const on = chosen.includes(item.value)
          return (
            // Name, site and count in columns, as a table of the source's creators.
            <li key={item.value} className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 hover:bg-hover">
              <div className="min-w-0 flex-1">
                <Checkbox
                  checked={on}
                  disabled={!on && full}
                  onCheckedChange={(next) => {
                    setNames((m) => new Map(m).set(item.value, item.label))
                    write(mode, next ? [...chosen, item.value] : chosen.filter((v) => v !== item.value))
                  }}
                >
                  <span className="block truncate">{item.label}</span>
                </Checkbox>
              </div>
              <span className="shrink-0 rounded border border-border px-1.5 text-xs leading-5 text-muted">
                {siteName(item.value.slice(0, item.value.indexOf("/")))}
              </span>
              <span className="w-14 shrink-0 text-right text-xs leading-5 text-muted tabular-nums">
                {item.count !== undefined ? count(item.count) : ""}
              </span>
            </li>
          )
        })}
      </ul>
      <MoreSuggestions suggestions={suggestions} kind="creators" />
      <ul
        aria-label="Chosen creators"
        data-layout-audit-ignore="inset: A chip's remove button sits in the pill's compact end, as in MultiSelect"
        className="flex min-h-9 flex-wrap content-start items-start gap-1.5"
      >
        {chosen.length === 0 && <li className="flex h-7 items-center text-xs text-muted">No creator filter set</li>}
        {chosen.map((identity) => (
          <li
            key={identity}
            className={`${chipClass} ${mode === "not" ? "border-danger/60 text-danger" : "border-accent/60"}`}
          >
            <span className={`min-w-0 truncate ${mode === "not" ? "line-through decoration-1" : ""}`} title={identity}>
              {nameOf(identity)}
            </span>
            <IconButton
              label={`Remove ${nameOf(identity)}`}
              hint="Takes this creator out of the filter."
              icon="close"
              className="size-6! shrink-0"
              onClick={() =>
                write(
                  mode,
                  chosen.filter((v) => v !== identity)
                )
              }
            />
          </li>
        ))}
      </ul>
      {full && <p className="text-xs text-muted">At most 20 creators.</p>}
    </div>
  )
}

/** A panel's controls: each panel has its own, as the archive's page has; nothing else renders. */
function PanelBody({ panel, browse, set }: { panel: Panel; browse: SourceBrowse; set: SetFilters }) {
  const caps = browse.caps!
  const filters = browse.remote.filters
  const first = panel.filters[0]!
  switch (panel.key) {
    case "Creators":
      return creatorIds(caps).includes(first.id) ? <CreatorsPanel browse={browse} set={set} /> : null
    case "Sites":
      return first.kind === "choice" && first.excludeId ? (
        <IncludeExcludePanel panel={panel} browse={browse} set={set} />
      ) : first.kind === "choice" ? (
        <ChecksPanel filter={first} filters={filters} set={set} />
      ) : null
    case "Kind":
    case "Rating":
      return first.kind === "choice" && !first.multi ? (
        <ChoicePanel filter={first} filters={filters} set={set} browse={browse} />
      ) : null
    case "Tokens":
      return first.kind === "range" ? <RangePanel filter={first} browse={browse} set={set} /> : null
    case "Added":
    case "Created":
      return isDatePair(panel) ? <DatePanel panel={panel} filters={filters} set={set} /> : null
    default:
      return null
  }
}

const panelAbout = (panel: Panel) => panel.filters.find((f) => f.about)?.about

/** A panel's accessible name: "Tokens: ≥ 300 tokens", or the summary when it names the panel ("Added: any date"). */
const panelName = (panel: Panel, summary: string) =>
  summary.startsWith(panel.title) ? summary : `${panel.title}: ${summary}`

/** Wide: a button that says what's chosen; its controls open under it. */
function PanelButton({ panel, browse, set }: { panel: Panel; browse: SourceBrowse; set: SetFilters }) {
  const [open, setOpen] = useState(false)
  const summary = summaryOf(browse, panel)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title={panel.title}
      triggerLabel={panelName(panel, summary)}
      hint={panelAbout(panel) ?? `Click to choose the ${panel.title.toLowerCase()}.`}
      side="bottom"
      tall
      wide={creatorIds(browse.caps!).includes(panel.filters[0]!.id)}
      triggerClassName={`${buttonClass("secondary")} max-w-full`}
      trigger={
        <span data-filter-panel={panel.key} className="truncate">
          {summary}
        </span>
      }
    >
      <div className="-m-2 min-h-0 overflow-y-auto p-2">
        <PanelBody panel={panel} browse={browse} set={set} />
      </div>
    </Popover>
  )
}

/** The checkboxes: switches, and a default the source applies (characters without a cover hidden). */
function Switches({
  browse,
  filters: list,
  set
}: {
  browse: SourceBrowse
  filters: ReadonlyArray<SourceFilter>
  set: SetFilters
}) {
  const filters = browse.remote.filters
  const active = activeDefaults(browse)
  return (
    <>
      {list.map((filter) => {
        const hidden = browse.caps?.hiddenByDefault?.find((d) => d.filterId === filter.id && d.toggle)
        if (hidden) {
          if (moot(hidden, filters)) return null
          return (
            <Checkbox
              key={filter.id}
              checked={active.includes(hidden)}
              labelHelp={
                <AboutHint heading={hidden.toggle!} info>
                  {hidden.about}
                </AboutHint>
              }
              onCheckedChange={(on) => set({ [filter.id]: on ? undefined : (hidden.off as SourceFilterValue) })}
            >
              {hidden.toggle}
            </Checkbox>
          )
        }
        return <ToggleBox key={filter.id} filter={filter} filters={filters} set={set} />
      })}
    </>
  )
}

/** Beside the search: the parts the words are looked for in, and how they're matched. */
function SearchOptions({
  browse,
  filters: list,
  set
}: {
  browse: SourceBrowse
  filters: ReadonlyArray<SourceFilter>
  set: SetFilters
}) {
  const [open, setOpen] = useState(false)
  const filters = browse.remote.filters
  return (
    <>
      {list.map((filter) => {
        if (filter.kind !== "choice") return null
        if (filter.multi) {
          const value = filters[filter.id]
          const chosen = Array.isArray(value) ? value : []
          const summary =
            chosen.length === 0 || chosen.length === filter.options.length
              ? "All text"
              : chosen.length <= 2
                ? chosen.map((v) => filter.options.find((o) => o.value === v)?.label ?? v).join(" + ")
                : `${chosen.length} of ${filter.options.length} parts`
          return (
            <Popover
              key={filter.id}
              open={open}
              onOpenChange={setOpen}
              title={filter.label}
              triggerLabel={`${filter.label}: ${summary}`}
              hint={filter.about ?? "The parts of a card the words are looked for in."}
              side="bottom"
              trigger={
                <span className="truncate">
                  <span className="text-muted">In: </span>
                  {summary}
                </span>
              }
            >
              {/* Every part is searched unless some are unticked; the last one stays ticked. */}
              <div role="group" aria-label={filter.label} className="flex flex-col gap-2.5">
                {filter.options.map((o) => {
                  const on = chosen.length === 0 || chosen.includes(o.value)
                  const all = filter.options.map((x) => x.value)
                  const current = chosen.length === 0 ? all : chosen
                  return (
                    <Checkbox
                      key={o.value}
                      checked={on}
                      disabled={on && current.length === 1}
                      onCheckedChange={(next) => {
                        const after = all.filter((v) => (v === o.value ? next : current.includes(v)))
                        set({ [filter.id]: after.length === all.length || after.length === 0 ? undefined : after })
                      }}
                    >
                      {o.label}
                    </Checkbox>
                  )
                })}
              </div>
            </Popover>
          )
        }
        const value = filters[filter.id]
        return (
          <span key={filter.id} className="inline-flex items-center gap-1">
            <Segmented
              label={filter.label}
              value={typeof value === "string" ? value : (filter.options[0]?.value ?? "")}
              onValueChange={(next) => set({ [filter.id]: next === filter.options[0]?.value ? undefined : next })}
              options={filter.options.map((o) => ({ value: o.value, label: o.label }))}
            />
            {filter.about && (
              <AboutHint heading={filter.label} info>
                {filter.about}
              </AboutHint>
            )}
          </span>
        )
      })}
    </>
  )
}

/** The phone's Filters sheet: the tags first, a folding row per panel, the checkboxes, Show results. */
function FiltersSheet({ browse, set }: { browse: SourceBrowse; set: SetFilters }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const caps = browse.caps!
  const { panels, switches } = layoutOf(caps)
  const total = totalLabel(browse.results)
  return (
    <Sheet open={browse.filtersOpen} onOpenChange={browse.setFiltersOpen} title="Filters" imageControls={false}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div data-filter-sheet className="flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto px-4">
          {(caps.tags.include || caps.tags.exclude) && (
            <section aria-label="Tags" className="flex flex-col gap-1 py-3">
              <TagInput browse={browse} inline />
            </section>
          )}
          {panels.map((panel) => {
            const open = expanded === panel.key
            const bodyId = `sheet-${panel.key}`
            return (
              <section key={panel.key} aria-label={panel.title} className="flex flex-col">
                <div className="flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={bodyId}
                    aria-label={panelName(panel, summaryOf(browse, panel))}
                    onClick={() => setExpanded(open ? null : panel.key)}
                    className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 text-left text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <span className="min-w-0 truncate">
                      {panel.title} <span className="font-normal text-muted">· {summaryOf(browse, panel)}</span>
                    </span>
                    <Icon name="down" className={open ? "rotate-180" : ""} />
                  </button>
                  {panelAbout(panel) && (
                    <AboutHint heading={panel.title} info>
                      {panelAbout(panel)}
                    </AboutHint>
                  )}
                </div>
                {open && (
                  <div id={bodyId} className="flex flex-col gap-2 pb-3">
                    <PanelBody panel={panel} browse={browse} set={set} />
                  </div>
                )}
              </section>
            )
          })}
          {switches.length > 0 && (
            <section aria-label="More filters" className="flex flex-col gap-3 py-3">
              <Switches browse={browse} filters={switches} set={set} />
            </section>
          )}
        </div>
        <div className="border-t border-border p-4">
          <Button
            variant="primary"
            className="w-full"
            hint="Closes the filters, to the cards they match."
            onClick={() => browse.setFiltersOpen(false)}
          >
            {total === null ? "Show results" : `Show results (${total})`}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

/** The filter bar (§3.2): always shown on a wide bar; on a narrow one its panels are in the Filters sheet. */
export function SourceFiltersPanel({
  browse,
  id,
  filtersButton = false
}: {
  browse: SourceBrowse
  id: string
  /** Show the Filters button on the bar's first row when narrow (where no other bar holds one). */
  filtersButton?: boolean
}) {
  const caps = browse.caps
  if (!caps) return null
  const set: SetFilters = (patch) => {
    const next = { ...browse.remote.filters }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    browse.change({ filters: next })
  }
  const { panels, switches, search } = layoutOf(caps)
  return (
    <div id={id} data-filter-bar className="flex min-w-0 flex-col gap-2">
      {(search.length > 0 || filtersButton) && (
        <div data-search-options className="flex min-w-0 flex-wrap items-center gap-2">
          <SearchOptions browse={browse} filters={search} set={set} />
          {filtersButton && <SourceFiltersButton browse={browse} panelId={id} />}
        </div>
      )}
      <div data-filter-panels className="hidden min-w-0 flex-wrap items-center gap-2 @xl:flex">
        {panels.map((panel) => (
          <PanelButton key={panel.key} panel={panel} browse={browse} set={set} />
        ))}
        {(caps.tags.include || caps.tags.exclude) && (
          <div className="max-w-64 min-w-48 flex-1">
            <TagInput browse={browse} />
          </div>
        )}
      </div>
      {switches.length > 0 && (
        <div data-filter-switches className="hidden min-w-0 flex-wrap items-center gap-x-4 gap-y-2 @xl:flex">
          <Switches browse={browse} filters={switches} set={set} />
        </div>
      )}
      <FiltersSheet browse={browse} set={set} />
    </div>
  )
}

const chipClass =
  "inline-flex h-8 min-w-0 max-w-full items-center gap-1 rounded-full border bg-surface pr-0.5 pl-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"

function Chip({
  children,
  onRemove,
  onClick,
  hint,
  removeLabel = "Remove",
  tone = "plain"
}: {
  children: ReactNode
  onRemove: () => void
  onClick?: (() => void) | undefined
  hint?: string | undefined
  removeLabel?: string
  /** A required tag, a left-out one, a default the source applies, or any other filter. */
  tone?: "include" | "exclude" | "default" | "plain"
}) {
  return (
    <span
      data-source-chip
      {...(tone === "default" ? { "data-default": "" } : {})}
      data-layout-audit-ignore="inset: A chip's remove button sits in the pill's compact end, as in MultiSelect"
      className={`${chipClass} ${tone === "include" ? "border-accent/60" : tone === "exclude" ? "border-danger/60 text-danger" : tone === "default" ? "border-dashed border-border text-muted" : "border-border"}`}
    >
      {onClick ? (
        <Tooltip label={hint ?? ""}>
          <button type="button" className="inline-flex min-w-0 items-center gap-1 outline-none" onClick={onClick}>
            <span data-layout-name className="truncate">
              {children}
            </span>
          </button>
        </Tooltip>
      ) : hint ? (
        <Tooltip label={hint}>
          <span data-layout-name tabIndex={0} className="min-w-0 truncate outline-none">
            {children}
          </span>
        </Tooltip>
      ) : (
        <span data-layout-name className="min-w-0 truncate">
          {children}
        </span>
      )}
      <IconButton
        label={removeLabel}
        hint="Removes this filter."
        icon="close"
        className="size-6! shrink-0"
        onClick={onRemove}
      />
    </span>
  )
}

/** Every filter in effect, each once, under the bar: what's chosen, then the source's defaults. */
export function SourceChips({ browse }: { browse: SourceBrowse }) {
  const caps = browse.caps
  if (!caps) return null
  const { remote } = browse
  const filters: Filters = browse.query?.filters ?? remote.filters
  const change = (patch: Patch) => {
    const next = { ...remote.filters }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    browse.change({ filters: next })
  }
  const chips: Array<ReactNode> = []
  const anyId = caps.tags.anyFilterId
  const sets: TagSets = {
    tags: remote.tags,
    excludeTags: remote.excludeTags,
    groups: anyId ? groupsOf(remote.filters[anyId]) : []
  }
  const writeTags = (next: TagSets) =>
    browse.change({
      tags: [...next.tags],
      excludeTags: [...next.excludeTags],
      ...(anyId
        ? (() => {
            const f = { ...remote.filters }
            const v = groupsText(next.groups)
            if (v === undefined) delete f[anyId]
            else f[anyId] = v
            return { filters: f }
          })()
        : {})
    })
  for (const tag of sets.tags)
    chips.push(
      <Chip
        key={`+${tag}`}
        tone="include"
        hint={`Included. Click to exclude ${tag} instead.`}
        onClick={
          caps.tags.exclude
            ? () => writeTags({ ...withoutTag(sets, tag), excludeTags: [...sets.excludeTags, tag] })
            : undefined
        }
        onRemove={() => writeTags(withoutTag(sets, tag))}
      >
        +{tag}
      </Chip>
    )
  sets.groups.forEach((group) =>
    chips.push(
      <Chip
        key={`any:${group.join("|")}`}
        tone="include"
        onRemove={() => writeTags({ ...sets, groups: sets.groups.filter((g) => g !== group) })}
      >
        Any of {group.join(" or ")}
      </Chip>
    )
  )
  for (const tag of sets.excludeTags)
    chips.push(
      <Chip
        key={`-${tag}`}
        tone="exclude"
        hint={`Excluded. Click to include ${tag} instead.`}
        onClick={
          caps.tags.include ? () => writeTags({ ...withoutTag(sets, tag), tags: [...sets.tags, tag] }) : undefined
        }
        onRemove={() => writeTags(withoutTag(sets, tag))}
      >
        <span className="sr-only">Not </span>
        <span aria-hidden="true">−</span>
        <span className="line-through decoration-1">{tag}</span>
      </Chip>
    )
  const creators = creatorIds(caps)
  const hiddenIds = new Set((caps.hiddenByDefault ?? []).map((d) => d.filterId))
  const { panels } = layoutOf(caps)
  const done = new Set<string>()
  if (creators.length) {
    const { mode, chosen } = creatorChoice(caps, filters)
    for (const identity of chosen)
      chips.push(
        <Chip
          key={`creator:${identity}`}
          tone={mode === "not" ? "exclude" : "plain"}
          onRemove={() => {
            const rest = chosen.filter((v) => v !== identity)
            const c = caps.creators!
            const patch: Record<string, SourceFilterValue | undefined> = { [c.filterId]: undefined }
            if (c.anyFilterId) patch[c.anyFilterId] = undefined
            if (c.excludeFilterId) patch[c.excludeFilterId] = undefined
            if (rest.length && mode === "not" && c.excludeFilterId) patch[c.excludeFilterId] = joinList(rest)
            else if (rest.length === 1 || (rest.length && !c.anyFilterId)) patch[c.filterId] = rest[0]!
            else if (rest.length && c.anyFilterId) patch[c.anyFilterId] = joinList(rest)
            change(patch)
          }}
        >
          {mode === "not" ? `Not by ${handle(identity)}` : `By ${handle(identity)}`}
        </Chip>
      )
    for (const id of creators) done.add(id)
  }
  for (const panel of panels) {
    if (isDatePair(panel)) {
      const [a, b] = panel.filters as [SourceFilter, SourceFilter]
      const from = typeof filters[a.id] === "string" ? (filters[a.id] as string) : ""
      const until = typeof filters[b.id] === "string" ? (filters[b.id] as string) : ""
      if (from || until)
        chips.push(
          <Chip key={panel.key} onRemove={() => change({ [a.id]: undefined, [b.id]: undefined })}>
            {dateWords(panel.title, from, until)}
          </Chip>
        )
      done.add(a.id).add(b.id)
    }
  }
  for (const filter of caps.filters) {
    if (done.has(filter.id) || filter.id === anyId) continue
    const value = filters[filter.id]
    if (value === undefined || value === false || value === "") continue
    if (caps.ratings?.filterId === filter.id && value === caps.ratings.default) continue
    // A default switched off shows as its chip's absence, not as a chip of its own.
    if (hiddenIds.has(filter.id) && caps.hiddenByDefault?.some((d) => d.filterId === filter.id && d.off === value))
      continue
    if (filter.kind === "choice") {
      const values = Array.isArray(value) ? value : [String(value)]
      const excluded = caps.filters.some((f) => f.kind === "choice" && f.excludeId === filter.id)
      const label = (v: string) => filter.options.find((o) => o.value === v)?.label ?? v
      if (filter.multi && filter.group)
        for (const v of values)
          chips.push(
            <Chip
              key={`${filter.id}:${v}`}
              tone={excluded ? "exclude" : "plain"}
              onRemove={() => {
                const rest = values.filter((x) => x !== v)
                change({ [filter.id]: rest.length ? rest : undefined })
              }}
            >
              {excluded ? `Not ${label(v)}` : label(v)}
            </Chip>
          )
      else
        chips.push(
          <Chip
            key={filter.id}
            onRemove={() =>
              change(
                caps.ratings?.filterId === filter.id && caps.ratings.default !== null
                  ? { [filter.id]: caps.ratings.default }
                  : { [filter.id]: undefined }
              )
            }
          >
            {`${filter.label}: ${values.map(label).join(", ")}`}
          </Chip>
        )
    } else if (filter.kind === "range" && isRange(value)) {
      const min = value.min ?? 0
      const unit = filter.unit ?? ""
      if (min === 0 && value.max === undefined) continue
      chips.push(
        <Chip key={filter.id} onRemove={() => change({ [filter.id]: undefined })}>
          {value.max === undefined
            ? `At least ${count(min)} ${unit}`.trim()
            : min === 0
              ? `Up to ${count(value.max)} ${unit}`.trim()
              : `${count(min)}–${count(value.max)} ${unit}`.trim()}
        </Chip>
      )
    } else if (filter.kind === "toggle")
      chips.push(
        <Chip key={filter.id} onRemove={() => change({ [filter.id]: undefined })}>
          {filter.label}
        </Chip>
      )
    else
      chips.push(
        <Chip key={filter.id} onRemove={() => change({ [filter.id]: undefined })}>
          {filter.id === "picture" ? "Cards sharing one picture" : `${filter.label}: ${String(value)}`}
        </Chip>
      )
  }
  for (const hidden of activeDefaults(browse))
    chips.push(
      <Chip
        key={`default:${hidden.id}`}
        tone="default"
        hint={hidden.about}
        removeLabel={`Include ${hidden.label.toLowerCase()}`}
        onRemove={() => change({ [hidden.filterId]: hidden.off as SourceFilterValue })}
      >
        {hidden.label} hidden <span className="text-xs">(default)</span>
      </Chip>
    )
  if (chips.length === 0 && browse.filterCount === 0) return null
  return (
    <div role="group" aria-label="Active filters" className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      {chips}
      {/* As on the archive's page: whenever a chip shows, every filter back to its default. */}
      <Tooltip label="Puts every filter back to its default.">
        <button
          type="button"
          className="rounded-sm px-1 text-accent underline outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => clearFilters(browse)}
        >
          Clear all
        </button>
      </Tooltip>
    </div>
  )
}

/** "1,000+ more cards are hidden (no cover or under 300 tokens). Show them": only when the defaults hid some. */
export function SourceHiddenNote({ browse }: { browse: SourceBrowse }) {
  const results = browse.results
  const active = browse.caps ? activeDefaults(browse) : []
  const hidden = results?.hidden ?? 0
  if (hidden <= 0 || active.length === 0) return null
  const reasons = active.map((d) => (d.min !== undefined ? `under ${count(d.min)} tokens` : "no cover"))
  const one = hidden === 1 && !results?.hiddenCapped
  return (
    <p data-source-hidden-note className="text-sm text-muted">
      {count(hidden)}
      {results?.hiddenCapped ? "+" : ""} more {one ? "card is" : "cards are"} hidden ({reasons.join(" or ")}).{" "}
      <Tooltip label="Includes the cards the archive leaves out by default.">
        <button
          type="button"
          className="rounded-sm text-accent underline outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => {
            const next = { ...browse.remote.filters }
            for (const d of active) next[d.filterId] = d.off as SourceFilterValue
            browse.change({ filters: next })
          }}
        >
          Show them
        </button>
      </Tooltip>
    </p>
  )
}
