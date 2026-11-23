// A card source's filter bar and the chips of what's set (spec/CARD-SOURCES.md §3.2), generated
// from its capabilities (§2.3). The tag field comes first. Then one section per group of
// criteria: on a wide bar a button that says what's chosen and opens the controls in a
// popover, on a narrow one a row that folds open in place. Then the switches, and the rarely
// used criteria under More filters. Every value is in the URL as it's typed, so a reload keeps it.
import type { SourceFilter, SourceFilterValue, SourceQuery } from "@dreamspan/shared/cardSources.ts"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { AboutHint } from "../../ui/AboutHint.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { InlinePanel } from "../../ui/InlinePanel.tsx"
import { MultiSelect } from "../../ui/MultiSelect.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { clearFilters, requirementMet, totalLabel, type SourceBrowse } from "./browse.tsx"
import { problemText, type SourceProblem, useSourceCall } from "./remote.ts"

const numberFormat = new Intl.NumberFormat()

type Range = { readonly min?: number; readonly max?: number }
const isRange = (value: SourceFilterValue | undefined): value is Range =>
  typeof value === "object" && !Array.isArray(value)

/** A filter's label, with its explanation in a "?" beside it (the field rule). */
function FilterLabel({ filter, id }: { filter: SourceFilter; id?: string }) {
  return (
    <div className="text-sm leading-5">
      <span id={id} className="font-medium">
        {filter.label}
      </span>
      {filter.about && (
        <>
          {" "}
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
  value: Range | undefined
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

/** Suggestions share the existing inline buttons for tags and capability-declared text fields. */
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
    const timer = setTimeout(() => request(null), 200)
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

function SuggestedValues({
  suggestions,
  kind,
  onChoose,
  exclude = false
}: {
  suggestions: ReturnType<typeof useSuggestions>
  kind: "tags" | "creators"
  onChoose: (value: string) => void
  /** A click leaves the tag out rather than requiring it. */
  exclude?: boolean
}) {
  return (
    <div aria-label={`Suggested ${kind}`} className="flex min-w-0 flex-wrap gap-1">
      {suggestions.items.map((item) => (
        <Button
          key={item.value}
          variant="ghost"
          className="h-auto min-h-7 max-w-full px-2 text-left text-xs whitespace-normal break-words"
          hint={exclude ? `Leaves out cards tagged ${item.value}.` : `Uses ${item.value} in this filter.`}
          onClick={() => onChoose(item.value)}
        >
          {exclude && <Icon name="ban" />}
          {kind === "creators" ? `${item.label} (${item.value})` : item.label}
          {item.count !== undefined && (
            <span className="text-muted tabular-nums">{numberFormat.format(item.count)}</span>
          )}
        </Button>
      ))}
      {suggestions.problem ? (
        <div className="w-full text-sm text-muted">
          {problemText("the archive", suggestions.problem)}{" "}
          <Button variant="ghost" hint="Asks for these suggestions again." onClick={suggestions.retry}>
            Retry
          </Button>
        </div>
      ) : suggestions.next ? (
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs"
          hint={`Shows more ${kind} matching what you typed.`}
          disabled={suggestions.loading}
          onClick={suggestions.more}
        >
          More {kind}
        </Button>
      ) : null}
    </div>
  )
}

function TextFilter({
  filter,
  value,
  onChange,
  browse
}: {
  filter: Extract<SourceFilter, { kind: "text" }>
  value: string
  onChange: (value: string | undefined) => void
  browse: SourceBrowse
}) {
  const parts = filter.suggestions?.multiple ? value.split(/(?<!\\),/) : [value]
  const prefix = (parts.at(-1) ?? "").trim().replace(/\\(.)/g, "$1")
  const suggestions = useSuggestions(browse, "creators", prefix, !!filter.suggestions && !!prefix)
  const choose = (chosen: string) => {
    if (!filter.suggestions?.multiple) return onChange(chosen)
    const escaped = chosen.replace(/\\/g, "\\\\").replace(/,/g, "\\,")
    onChange([...parts.slice(0, -1), escaped].join(","))
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Field label={filter.label} about={filter.about}>
        <Input
          {...(filter.format === "date" ? { type: "date", "data-date-filter": filter.id } : {})}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value || undefined)}
        />
      </Field>
      {filter.suggestions && <SuggestedValues suggestions={suggestions} kind="creators" onChoose={choose} />}
    </div>
  )
}

/** The text a tag is looked up by: what's typed, without the leading "-" that leaves it out. */
const tagText = (text: string) => text.trim().replace(/^-+\s*/, "")

/**
 * The tag field: Enter requires the tag typed, or leaves it out when it starts with "-". While
 * the field is in use, the source's tags matching it are offered with their counts.
 */
function TagField({ browse }: { browse: SourceBrowse }) {
  const [text, setText] = useState("")
  const [inUse, setInUse] = useState(false)
  const canExclude = browse.caps?.tags.exclude === true
  const excluding = canExclude && text.trimStart().startsWith("-")
  const shown = inUse
  const box = useRef<HTMLDivElement>(null)
  // The list closes when a press or focus lands outside the field and its list.
  useEffect(() => {
    if (!inUse) return
    const outside = (event: Event) => {
      if (!box.current?.contains(event.target as Node | null)) setInUse(false)
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("focusin", outside)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("focusin", outside)
    }
  }, [inUse])
  const suggestions = useSuggestions(browse, "tags", tagText(text), browse.caps?.tags.suggest === true && shown)
  const add = (tag: string, leaveOut: boolean) => {
    const clean = tag.trim()
    if (clean === "") return
    const { tags, excludeTags } = browse.remote
    if (leaveOut) {
      if (excludeTags.includes(clean)) return
      browse.change({ tags: tags.filter((t) => t !== clean), excludeTags: [...excludeTags, clean] })
    } else {
      if (tags.includes(clean)) return
      browse.change({ tags: [...tags, clean], excludeTags: excludeTags.filter((t) => t !== clean) })
    }
    setText("")
  }
  return (
    <div ref={box} className="relative flex min-w-0 flex-col gap-1.5" onFocus={() => setInUse(true)}>
      <Field
        label="Tags"
        about={
          canExclude
            ? "Enter requires the tag; start it with - to leave it out instead. Click a tag's chip to switch between the two."
            : "Enter requires the tag."
        }
      >
        <Input
          value={text}
          placeholder={canExclude ? "Add a tag (-tag leaves it out)" : "Add a tag"}
          onChange={(event) => {
            setText(event.currentTarget.value)
            setInUse(true)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              add(tagText(text), excluding)
              // The list closes on Enter; typing the next tag opens it again.
              setInUse(false)
            } else if (event.key === "Escape" && inUse) {
              // Closes the list only, not the filters.
              event.preventDefault()
              setInUse(false)
            }
          }}
        />
      </Field>
      {shown && (suggestions.items.length > 0 || suggestions.next !== null || suggestions.problem) && (
        // Floats under the field, so opening and closing it moves nothing on the page.
        <div
          data-layout-overlay="Tag suggestions float under the tag field"
          className="absolute top-full right-0 left-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-surface p-2 shadow-lg"
        >
          <SuggestedValues
            suggestions={suggestions}
            kind="tags"
            exclude={excluding}
            onChoose={(tag) => add(tag, excluding)}
          />
        </div>
      )}
    </div>
  )
}

/** More choices than this, and a several-choice filter is a picker rather than a row of buttons. */
const LONG_CHOICES = 8

type SetFilter = (filterId: string, value: SourceFilterValue | undefined) => void

/** One criterion's control, by its kind. */
function FilterControl({ filter, browse, set }: { filter: SourceFilter; browse: SourceBrowse; set: SetFilter }) {
  const filters = browse.query?.filters ?? {}
  const value = filters[filter.id]
  switch (filter.kind) {
    case "choice": {
      const options = filter.options.map((o) => ({
        value: o.value,
        label: o.label,
        description: `Filters by ${filter.label.toLowerCase()}: ${o.label.toLowerCase()}.`
      }))
      if (filter.multi && filter.options.length > LONG_CHOICES)
        // A long list of choices: the existing picker, with a search past eight.
        return (
          <Field label={filter.label} about={filter.about}>
            <MultiSelect
              items={filter.options.map((o) => ({ value: o.value, label: o.label }))}
              value={Array.isArray(value) ? value : []}
              addLabel="Add"
              chosenLabel={`Chosen: ${filter.label.toLowerCase()}`}
              listLabel={`Choose: ${filter.label.toLowerCase()}`}
              explanation={filter.about}
              onValueChange={(chosen) => set(filter.id, chosen.length ? [...chosen] : undefined)}
            />
          </Field>
        )
      return (
        <div className="flex min-w-0 flex-col gap-1.5">
          <FilterLabel filter={filter} />
          {filter.multi ? (
            <Segmented
              multiple
              wrap
              label={filter.label}
              value={Array.isArray(value) ? value : []}
              onValueChange={(chosen) => set(filter.id, chosen.length ? chosen : undefined)}
              options={options}
            />
          ) : (
            <Segmented
              wrap
              label={filter.label}
              value={typeof value === "string" ? value : null}
              onValueChange={(chosen) => set(filter.id, chosen)}
              options={options}
            />
          )}
        </div>
      )
    }
    case "range":
      return (
        <RangeFilter filter={filter} value={isRange(value) ? value : undefined} onChange={(r) => set(filter.id, r)} />
      )
    case "toggle": {
      const met = requirementMet(filter, filters)
      return (
        <Switch
          checked={value === true}
          disabled={!met}
          onCheckedChange={(on) => set(filter.id, on ? true : undefined)}
          about={!met ? filter.requires!.about : (filter.about ?? toggleAbout(filter))}
        >
          {filter.label}
        </Switch>
      )
    }
    case "text":
      return (
        <TextFilter
          filter={filter}
          browse={browse}
          value={typeof value === "string" ? value : ""}
          onChange={(next) => set(filter.id, next)}
        />
      )
  }
}

const toggleAbout = (filter: SourceFilter) =>
  `On: only cards that ${filter.label.toLowerCase().replace(/^has /, "have ")}.`

/** Criteria shown together: one button or folding row, named by their group. */
interface Section {
  readonly key: string
  readonly label: string
  readonly filters: Array<SourceFilter>
}

/** The bar's parts from the capabilities: the sections, the plain switches, and More filters. */
const layoutOf = (filters: ReadonlyArray<SourceFilter>) => {
  const sections: Array<Section> = []
  const more: Array<Section> = []
  const switches: Array<SourceFilter> = []
  for (const filter of filters) {
    if (!filter.more && !filter.group && filter.kind === "toggle") {
      switches.push(filter)
      continue
    }
    const list = filter.more ? more : sections
    const key = filter.group ?? filter.id
    const found = list.find((s) => s.key === key)
    if (found) found.filters.push(filter)
    else list.push({ key, label: filter.group ?? filter.label, filters: [filter] })
  }
  return { sections, more, switches }
}

/** A section that is a pair of dates: from the first, until the second. */
const isDatePair = (section: Section) =>
  section.filters.length === 2 && section.filters.every((f) => f.kind === "text" && f.format === "date")

const rangeText = (range: Range) =>
  range.min !== undefined && range.max !== undefined
    ? `${numberFormat.format(range.min)}–${numberFormat.format(range.max)}`
    : range.min !== undefined
      ? `≥ ${numberFormat.format(range.min)}`
      : `≤ ${numberFormat.format(range.max ?? 0)}`

/** A value as words: the options' labels, a range, the text. */
const valueText = (filter: SourceFilter, value: SourceFilterValue) =>
  filter.kind === "toggle"
    ? filter.label
    : filter.kind === "choice"
      ? (Array.isArray(value) ? value : [String(value)])
          .map((v) => filter.options.find((o) => o.value === v)?.label ?? v)
          .join(", ")
      : filter.kind === "range" && isRange(value)
        ? rangeText(value)
        : String(value)

const dateSpan = (from: SourceFilterValue | undefined, until: SourceFilterValue | undefined) =>
  from !== undefined && until !== undefined
    ? `${String(from)} – ${String(until)}`
    : from !== undefined
      ? `from ${String(from)}`
      : `until ${String(until)}`

/** Whether a filter is set away from its default (the remembered rating counts only when it isn't the default). */
const isSet = (browse: SourceBrowse, filter: SourceFilter) => {
  const value = browse.query?.filters[filter.id]
  const ratings = browse.caps?.ratings
  return (
    value !== undefined &&
    value !== false &&
    value !== "" &&
    !(ratings?.filterId === filter.id && value === ratings.default)
  )
}

/** What a section's button says: what's chosen in it, or "Any". */
const summaryOf = (browse: SourceBrowse, section: Section) => {
  const filters = browse.query?.filters ?? {}
  const chosen = section.filters.filter((f) => isSet(browse, f))
  if (isDatePair(section))
    return chosen.length ? dateSpan(filters[section.filters[0]!.id], filters[section.filters[1]!.id]) : "Any"
  if (chosen.length > 1) return `${chosen.length} set`
  const filter = chosen[0]
  if (filter === undefined) {
    // A choice with a value even when unset (the remembered rating) says what it is.
    const shown = section.filters.find((f) => f.kind === "choice" && filters[f.id] !== undefined)
    return shown ? valueText(shown, filters[shown.id]!) : "Any"
  }
  const text = valueText(filter, filters[filter.id]!)
  return filter === section.filters[0] || filter.kind === "toggle" ? text : `${filter.label}: ${text}`
}

/** Removes one filter: back to the source's default rating, or to nothing. */
const filtersWithout = (browse: SourceBrowse, ids: ReadonlyArray<string>) => {
  const ratings = browse.caps?.ratings
  const next = { ...browse.remote.filters }
  for (const id of ids) {
    delete next[id]
    if (ratings?.filterId === id && ratings.default !== null) next[id] = ratings.default
  }
  return next
}

/** A section's controls, and Clear while any of them is set. */
function SectionBody({ browse, section, set }: { browse: SourceBrowse; section: Section; set: SetFilter }) {
  const chosen = section.filters.some((f) => isSet(browse, f))
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className={`grid min-w-0 gap-3 ${isDatePair(section) ? "grid-cols-2" : ""}`}>
        {section.filters.map((filter) => (
          <FilterControl key={filter.id} filter={filter} browse={browse} set={set} />
        ))}
      </div>
      {chosen && (
        <Button
          variant="ghost"
          className="h-7 self-start px-2 text-xs"
          hint={`Clears the ${section.label.toLowerCase()} filters.`}
          onClick={() =>
            browse.change({
              filters: filtersWithout(
                browse,
                section.filters.map((f) => f.id)
              )
            })
          }
        >
          Clear {section.label.toLowerCase()}
        </Button>
      )}
    </div>
  )
}

const sectionHint = (section: Section) =>
  section.filters.length === 1 && section.filters[0]!.about
    ? section.filters[0]!.about
    : `Click to choose the ${section.label.toLowerCase()} filters.`

/** Wide: a button per section that says what's chosen; its controls open in a popover under it. */
function SectionButton({ browse, section, set }: { browse: SourceBrowse; section: Section; set: SetFilter }) {
  const [open, setOpen] = useState(false)
  const summary = summaryOf(browse, section)
  const active = section.filters.some((f) => isSet(browse, f))
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title={section.label}
      triggerLabel={`${section.label}: ${summary}`}
      hint={sectionHint(section)}
      side="bottom"
      wide={section.filters.length > 1}
      triggerClassName={`${buttonClass("secondary")} max-w-full gap-1.5 ${active ? "border-accent" : ""}`}
      trigger={
        <span data-filter-section={section.key} className="flex min-w-0 items-center gap-1.5">
          <span>{section.label}</span>
          <span className={`min-w-0 truncate font-normal ${active ? "text-text" : "text-muted"}`}>{summary}</span>
          <Icon name="down" />
        </span>
      }
    >
      {/* Escape closes the popover only, not the whole bar. */}
      <div
        className="-m-2 min-h-0 overflow-y-auto p-2"
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation()
        }}
      >
        <SectionBody browse={browse} section={section} set={set} />
      </div>
    </Popover>
  )
}

/** Narrow: a row per section that says what's chosen and folds open in place. */
function SectionRow({
  browse,
  section,
  set,
  open,
  onToggle
}: {
  browse: SourceBrowse
  section: Section
  set: SetFilter
  open: boolean
  onToggle: () => void
}) {
  const id = useId()
  const summary = summaryOf(browse, section)
  const active = section.filters.some((f) => isSet(browse, f))
  return (
    <div className="flex min-w-0 flex-col">
      <Tooltip label={sectionHint(section)}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          aria-label={`${section.label}: ${summary}`}
          onClick={onToggle}
          className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span className="shrink-0 font-medium">{section.label}</span>
          <span className={`min-w-0 flex-1 truncate ${active ? "text-text" : "text-muted"}`}>{summary}</span>
          <Icon name="down" className={open ? "rotate-180" : ""} />
        </button>
      </Tooltip>
      {open && (
        <div id={id} className="mt-1 mb-3">
          <SectionBody browse={browse} section={section} set={set} />
        </div>
      )}
    </div>
  )
}

/** The filter bar: tags, the sections, the switches, More filters (§3.2). */
export function SourceFiltersPanel({ browse, id }: { browse: SourceBrowse; id: string }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const caps = browse.caps
  if (!browse.filtersOpen || !caps) return null
  const set: SetFilter = (filterId, value) => {
    const next = { ...browse.remote.filters }
    if (value === undefined) delete next[filterId]
    else next[filterId] = value
    browse.change({ filters: next })
  }
  const { sections, more, switches } = layoutOf(caps.filters)
  const moreSet = more.flatMap((s) => s.filters).filter((f) => isSet(browse, f)).length
  const total = totalLabel(browse.results)
  return (
    <InlinePanel id={id} title={`${browse.info?.name ?? ""} filters`} onClose={() => browse.setFiltersOpen(false)}>
      <div className="flex min-w-0 flex-col gap-3">
        {(caps.tags.include || caps.tags.exclude) && <TagField browse={browse} />}
        {sections.length > 0 && (
          <>
            <div data-filter-sections="buttons" className="hidden flex-wrap gap-2 @xl:flex">
              {sections.map((section) => (
                <SectionButton key={section.key} browse={browse} section={section} set={set} />
              ))}
            </div>
            <div data-filter-sections="rows" className="flex min-w-0 flex-col divide-y divide-border @xl:hidden">
              {sections.map((section) => (
                <SectionRow
                  key={section.key}
                  browse={browse}
                  section={section}
                  set={set}
                  open={expanded === section.key}
                  onToggle={() => setExpanded(expanded === section.key ? null : section.key)}
                />
              ))}
            </div>
          </>
        )}
        {switches.length > 0 && (
          <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-2">
            {switches.map((filter) => (
              <FilterControl key={filter.id} filter={filter} browse={browse} set={set} />
            ))}
          </div>
        )}
        {more.length > 0 && (
          <div className="flex min-w-0 flex-col gap-3 border-t border-border pt-2">
            <Tooltip
              label={moreOpen ? "Click to hide the rarely used filters" : "Click to show the rarely used filters"}
            >
              <button
                type="button"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen(!moreOpen)}
                className="flex min-h-9 items-center gap-1.5 self-start rounded-md px-1 text-sm font-medium text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Icon name="right" className={moreOpen ? "rotate-90" : ""} />
                More filters
                {moreSet > 0 && <span className="tabular-nums">{moreSet}</span>}
              </button>
            </Tooltip>
            {moreOpen && (
              <div className="grid min-w-0 gap-4 @xl:grid-cols-2">
                {more
                  .flatMap((section) => section.filters)
                  .map((filter) => (
                    <FilterControl key={filter.id} filter={filter} browse={browse} set={set} />
                  ))}
              </div>
            )}
          </div>
        )}
        <Button
          variant="primary"
          className="w-full @xl:hidden"
          hint="Closes the filters, to the cards they match."
          onClick={() => browse.setFiltersOpen(false)}
        >
          {total === null ? "Show results" : `Show ${total} results`}
        </Button>
      </div>
    </InlinePanel>
  )
}

const chipClass =
  "inline-flex h-7 min-w-0 max-w-full items-center gap-1 rounded-full border bg-surface pr-0.5 pl-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus"

function Chip({
  children,
  onRemove,
  onClick,
  hint,
  tone = "plain"
}: {
  children: ReactNode
  onRemove: () => void
  onClick?: (() => void) | undefined
  hint?: string | undefined
  /** A required tag, a left-out one, or any other filter. */
  tone?: "include" | "exclude" | "plain"
}) {
  return (
    <span
      data-source-chip
      data-layout-audit-ignore="inset: A chip's remove button sits in the pill's compact end, as in MultiSelect"
      className={`${chipClass} ${tone === "include" ? "border-accent/60" : tone === "exclude" ? "border-danger/60 text-danger" : "border-border"}`}
    >
      {onClick ? (
        <Tooltip label={hint ?? ""}>
          <button type="button" className="inline-flex min-w-0 items-center gap-1 outline-none" onClick={onClick}>
            <span data-layout-name className="truncate">
              {children}
            </span>
          </button>
        </Tooltip>
      ) : (
        <span data-layout-name className="min-w-0 truncate">
          {children}
        </span>
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

/** The filters set, as chips on one line under the search; nothing at all when none are (§3.2). */
export function SourceChips({ browse }: { browse: SourceBrowse }) {
  const caps = browse.caps
  if (!caps) return null
  const { remote } = browse
  const effective: SourceQuery["filters"] = browse.query?.filters ?? {}
  const chips: Array<ReactNode> = []
  for (const tag of remote.tags)
    chips.push(
      <Chip
        key={`+${tag}`}
        tone="include"
        hint={`Click to leave out ${tag} instead`}
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
        tone="exclude"
        hint={`Click to require ${tag} instead`}
        onClick={
          caps.tags.include
            ? () =>
                browse.change({
                  tags: [...remote.tags, tag],
                  excludeTags: remote.excludeTags.filter((t) => t !== tag)
                })
            : undefined
        }
        onRemove={() => browse.change({ excludeTags: remote.excludeTags.filter((t) => t !== tag) })}
      >
        <span className="sr-only">Not </span>
        <span aria-hidden="true">−</span>
        {tag}
      </Chip>
    )
  const { sections, more } = layoutOf(caps.filters)
  const pairs = [...sections, ...more].filter(isDatePair)
  for (const filter of caps.filters) {
    const pair = pairs.find((s) => s.filters.includes(filter))
    if (pair) {
      // A date range is one chip, from its first date.
      if (pair.filters[0] !== filter || !pair.filters.some((f) => isSet(browse, f))) continue
      chips.push(
        <Chip
          key={pair.key}
          onRemove={() =>
            browse.change({
              filters: filtersWithout(
                browse,
                pair.filters.map((f) => f.id)
              )
            })
          }
        >
          {`${pair.label}: ${dateSpan(effective[pair.filters[0]!.id], effective[pair.filters[1]!.id])}`}
        </Chip>
      )
      continue
    }
    if (!isSet(browse, filter)) continue
    const value = effective[filter.id]!
    chips.push(
      <Chip key={filter.id} onRemove={() => browse.change({ filters: filtersWithout(browse, [filter.id]) })}>
        {filter.kind === "toggle"
          ? filter.label
          : filter.kind === "range"
            ? `${filter.label} ${valueText(filter, value)}`
            : `${filter.label}: ${valueText(filter, value)}`}
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
