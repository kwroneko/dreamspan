import { Tooltip } from "../../ui/Tooltip.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { PersonaBadge } from "../../ui/PersonaBadge.tsx"
import { usePlaceParam } from "../../usePlaceParam.ts"
// The library: every card, lorebook and preset, found by name and opened from here. Each
// item shows what identifies it, a direct action or two, and the rest in its menu.
import { useAtomValue } from "@effect/atom-react"
import type { CastCard } from "@rp/shared/chat.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import type { ExportFormatInfo } from "@rp/shared/libraryImport.ts"
import { Link, useLocation, useNavigate, useRouter, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { CARD_DRAG, carryOnDrag } from "../../ui/appDrags.ts"
import { AsyncView } from "../../actions.tsx"
import { useSession } from "../../session.ts"
import { SlotOutlet } from "../../slots.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge, Card, EmptyState } from "../../ui/Surface.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { CardSurface } from "../cardForks/surfaces.tsx"
import { usageLine } from "../characters/data.ts"
import { FavouriteStar, SortDirection } from "../characters/cardBrowse.tsx"
import { shellAtom, type ShellLibrary } from "../characters/shellData.tsx"
import { useTitle } from "../shell.tsx"
import { PRESET_VIEWS, type PresetView, presetDetail, presetsInView } from "../pickers/presetList.ts"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { LISTED, libraryAtom } from "./data.ts"
import { itemName, LibraryItemActions } from "./itemActions.tsx"
import { libraryActions, libraryPanels } from "./slots.ts"

type Kind = (typeof LISTED)[number]["kind"]
type Show = "all" | "characters" | "personas"
type Sort = "used" | "name" | "chats" | "changed" | "added"
type View = "list" | "grid"
interface Prefs {
  readonly kind: Kind
  readonly show: Show
  readonly sort: Sort
  /** The sort the other way round: oldest or fewest first, Z to A. */
  readonly reversed: boolean
  readonly view: View
}
const DEFAULTS: Prefs = { kind: "card", show: "all", sort: "used", reversed: false, view: "list" }

declare module "@tanstack/react-router" {
  interface HistoryState {
    libraryBrowse?: boolean
  }
}
const keys = ["kind", "show", "sort", "reverse", "view", "q", "presets"]
const readPrefs = (s: Record<string, unknown>): Prefs => ({
  kind: LISTED.find((k) => k.kind === s.kind)?.kind ?? "card",
  show: (["all", "characters", "personas"] as const).find((v) => v === s.show) ?? "all",
  sort: (["used", "name", "chats", "changed", "added"] as const).find((v) => v === s.sort) ?? "used",
  reversed: s.reverse === true,
  view: s.view === "grid" ? "grid" : "list"
})
const writePrefs = (s: Prefs) => ({
  kind: s.kind === "card" ? undefined : s.kind,
  show: s.show === "all" ? undefined : s.show,
  sort: s.sort === "used" ? undefined : s.sort,
  reverse: s.reversed || undefined,
  view: s.view === "list" ? undefined : s.view
})
function usePrefs() {
  const key = `rp.library.${useSession().user.id}`
  const presetSort = useViewPrefs().prefs.presetSort
  const [remembered] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as Prefs
      return readPrefs({ ...stored, reverse: stored.reversed })
    } catch {
      return DEFAULTS
    }
  })
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const marked = useLocation({ select: (l) => l.state.libraryBrowse === true })
  const pathname = useLocation({ select: (l) => l.pathname })
  const router = useRouter()
  const navigate = useNavigate()
  const prefs = !marked && !keys.some((k) => search[k] !== undefined) ? remembered : readPrefs(search)
  useEffect(() => {
    if (!marked && pathname === "/library" && router.latestLocation.pathname === "/library")
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          ...writePrefs(prefs),
          ...(!keys.some((k) => prev[k] !== undefined) && presetSort !== "name" ? { presets: presetSort } : {})
        }),
        state: (prev) => ({ ...prev, libraryBrowse: true }),
        replace: true,
        resetScroll: false
      })
  }, [marked, pathname, router, navigate, prefs, presetSort])
  const update = (change: Partial<Prefs>) => {
    const next = { ...prefs, ...change }
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      /* URL still carries it. */
    }
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...writePrefs({ ...readPrefs(prev), ...change }) }),
      state: (prev) => ({ ...prev, libraryBrowse: true }),
      replace: change.kind === undefined,
      resetScroll: false
    })
  }
  return [prefs, update] as const
}

/** True once the element has come near the viewport: per-item reads wait for it. */
function useSeen<E extends Element>() {
  const ref = useRef<E>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (seen || !element) return
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), {
      rootMargin: "400px 0px"
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [seen])
  return [ref, seen] as const
}

interface Usage {
  readonly chats: number
  readonly lastMessageAt: number | null
}
interface Item {
  readonly entry: LibraryRef
  readonly card: CastCard | undefined
  readonly usage: Usage | undefined
  /** A preset's line: when it was edited, used or archived. */
  readonly detail?: string
  /** A character's shell card (not a persona's), for its favourite star. */
  readonly shell: ShellCard | undefined
  /** Shown in a persona-only list (Personas), where a persona badge would mark every row. */
  readonly personaOnly?: boolean
}
type ShellCard = ShellLibrary["cards"][number]
const persona = (item: Item) => item.card?.persona === true

/** What a sort orders by, largest (newest, most) first; null: nothing to order by, last either way. */
const SORTS: Record<Exclude<Sort, "name">, (item: Item) => number | null> = {
  used: (item) => item.usage?.lastMessageAt ?? null,
  chats: (item) => item.usage?.chats ?? null,
  changed: (item) => item.entry.updatedAt,
  added: (item) => item.entry.addedAt ?? item.shell?.addedAt ?? null
}
const byName = (a: Item, b: Item) =>
  a.entry.label.localeCompare(b.entry.label) || a.entry.subtitle.localeCompare(b.entry.subtitle)
/**
 * Largest first and names A to Z; `reversed`, the other way round, as the other character
 * surfaces sort (characters/cardRecency.ts). A card never used comes last either way; name
 * breaks ties.
 */
const compareItems = (sort: Sort, reversed: boolean) => (a: Item, b: Item) => {
  const turn = reversed ? -1 : 1
  if (sort === "name") return turn * byName(a, b)
  const x = SORTS[sort](a)
  const y = SORTS[sort](b)
  if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1
  return turn * (y - x) || byName(a, b)
}

const matches = (needle: string, ...texts: ReadonlyArray<string | undefined>) =>
  texts.some((text) => text?.toLowerCase().includes(needle))

/** What an item says under its name: how it's used, plus non-card subtitles. */
function Meta({ item }: { item: Item }) {
  const usage = item.usage ? usageLine(item.usage) : (item.detail ?? null)
  const subtitle = item.entry.kind === "card" ? "" : item.entry.subtitle
  return (
    <>
      {subtitle && <span>{subtitle}</span>}
      {subtitle && usage && " · "}
      {usage}
    </>
  )
}

function Badges({ item, seen }: { item: Item; seen: boolean }) {
  const { entry } = item
  return (
    <>
      {persona(item) && !item.personaOnly && <PersonaBadge />}
      {entry.kind !== "card" && entry.parentEntityId !== null && <Badge>variant</Badge>}
      {entry.updateAvailable && <Badge tone="warning">update available</Badge>}
      {entry.kind === "card" && seen && <CardSurface placement="badge" entityId={entry.entityId} label={entry.label} />}
    </>
  )
}

/** Where an item's picture and name lead: a character's page, else its editor. The picture's
 * link repeats the name's for a pointer, so it's skipped by the keyboard and screen readers. */
function OpenLink({
  item,
  className,
  picture = false,
  children
}: {
  item: Item
  className: string
  picture?: boolean
  children: ReactNode
}) {
  const { entry } = item
  const props = picture
    ? {
        tabIndex: -1,
        "aria-hidden": true,
        "data-layout-audit-ignore": "inset: portrait is a whole-surface hit target",
        className
      }
    : { title: itemName(entry), className }
  return entry.kind === "card" ? (
    <Tooltip label={`Opens ${entry.label}’s card.`}>
      <Link
        to="/cards/$entityId"
        params={{ entityId: entry.entityId }}
        // Dropped on a frame, the card's full-size editor opens there (owner, 2026-11-07).
        onDragStart={(event) =>
          carryOnDrag(event.dataTransfer, CARD_DRAG.id, `/library/${encodeURIComponent(entry.id)}`)
        }
        {...props}
      >
        {children}
      </Link>
    </Tooltip>
  ) : (
    <Tooltip label={`Opens ${entry.label}’s editor.`}>
      <Link to="/library/$refId" params={{ refId: entry.id }} {...props}>
        {children}
      </Link>
    </Tooltip>
  )
}
const nameLink =
  "rounded-sm font-medium outline-none [overflow-wrap:anywhere] hover:underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-focus"

function Picture({ item, size }: { item: Item; size: "lg" | "fill" }) {
  const { entry } = item
  if (entry.kind === "card")
    return (
      <Avatar
        id={entry.entityId}
        name={entry.label}
        mediaId={item.card?.avatarMediaId ?? null}
        crop={item.card?.avatarCrop}
        size={size}
      />
    )
  return (
    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-raised text-muted">
      <Icon name={entry.kind === "lorebook" ? "book" : "sliders"} size={20} />
    </span>
  )
}

function Row({ item, formats }: { item: Item; formats: ReadonlyArray<ExportFormatInfo> }) {
  const [ref, seen] = useSeen<HTMLLIElement>()
  const { entry } = item
  // A card always has a line under its name (badges, usage); a lorebook or preset may not.
  const line =
    entry.kind === "card" ||
    entry.subtitle !== "" ||
    entry.parentEntityId !== null ||
    entry.updateAvailable ||
    item.detail !== undefined
  // The name beside the actions, and the line under it: one row, never wrapped. On a phone the
  // line runs on beneath the actions; wider, the actions stand centred beside both lines.
  return (
    <li
      ref={ref}
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2 [contain-intrinsic-size:auto_4.75rem] [content-visibility:auto]"
    >
      <OpenLink item={item} picture className="col-start-1 row-span-2 row-start-1 flex shrink-0 self-center">
        <Picture item={item} size="lg" />
      </OpenLink>
      <OpenLink
        item={item}
        className={`col-start-2 row-start-1 line-clamp-2 ${line ? "self-end" : "row-span-2 self-center"} ${nameLink}`}
      >
        {entry.label}
      </OpenLink>
      {line && (
        <span className="col-span-2 col-start-2 row-start-2 flex min-h-5 min-w-0 items-center gap-1.5 self-start text-xs text-muted sm:col-span-1">
          <Badges item={item} seen={seen} />
          <span className="min-w-0 truncate">
            <Meta item={item} />
          </span>
        </span>
      )}
      <div className="col-start-3 row-start-1 flex items-center gap-0.5 sm:row-span-2">
        {item.shell && <FavouriteStar card={item.shell} />}
        <LibraryItemActions context={{ entry: item.entry, persona: persona(item), exportFormats: formats }} />
      </div>
    </li>
  )
}

function Tile({ item, formats }: { item: Item; formats: ReadonlyArray<ExportFormatInfo> }) {
  const [ref, seen] = useSeen<HTMLLIElement>()
  return (
    <li
      ref={ref}
      className="tile-toggle-surface flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface [contain-intrinsic-size:auto_22rem] [content-visibility:auto]"
    >
      <OpenLink item={item} picture className="block aspect-[2/3] w-full overflow-hidden">
        <Picture item={item} size="fill" />
      </OpenLink>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2">
        <OpenLink item={item} className={`line-clamp-2 text-sm ${nameLink}`}>
          {item.entry.label}
        </OpenLink>
        <span className="truncate text-xs text-muted">
          <Meta item={item} />
        </span>
        <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-1 text-xs">
          <Badges item={item} seen={seen} />
        </span>
        <div className="mt-auto flex flex-wrap items-center justify-end gap-0.5 pt-2">
          {item.shell && <FavouriteStar card={item.shell} className="tile-toggle" />}
          <LibraryItemActions context={{ entry: item.entry, persona: persona(item), exportFormats: formats }} />
        </div>
      </div>
    </li>
  )
}

function Items({
  title,
  items,
  view,
  formats
}: {
  title: string
  items: ReadonlyArray<Item>
  view: View
  formats: ReadonlyArray<ExportFormatInfo>
}) {
  return view === "grid" ? (
    <ul aria-label={title} className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3">
      {items.map((item) => (
        <Tile key={item.entry.id} item={item} formats={formats} />
      ))}
    </ul>
  ) : (
    <Card className="py-2!">
      <ul aria-label={title} className="flex flex-col divide-y divide-border">
        {items.map((item) => (
          <Row key={item.entry.id} item={item} formats={formats} />
        ))}
      </ul>
    </Card>
  )
}

function Section({
  kind,
  title,
  all,
  archived = [],
  prefs,
  setPrefs,
  formats
}: {
  kind: Kind
  title: string
  all: ReadonlyArray<Item>
  /** Archived entries, for the presets' Archived view. */
  archived?: ReadonlyArray<LibraryRef>
  prefs: Prefs
  setPrefs: (change: Partial<Prefs>) => void
  formats: ReadonlyArray<ExportFormatInfo>
}) {
  const [search, changeSearch] = usePlaceParam("q", "")
  const setSearch = (next: string) => changeSearch(next, true)
  const needle = search.trim().toLowerCase()
  const cards = kind === "card"
  // Presets list as the preset pickers do: Name, Modified, Used or Archived (pickers/presetList.ts).
  const presets = kind === "preset"
  const views = useViewPrefs()
  const [presetView, setPresetView] = usePlaceParam<PresetView>(
    "presets",
    "name",
    PRESET_VIEWS.map((v) => v.value)
  )
  const shown = cards
    ? all
        .filter((item) => prefs.show === "all" || (prefs.show === "personas") === persona(item))
        .map((item) => (prefs.show === "personas" ? { ...item, personaOnly: true } : item))
    : all
  const items: ReadonlyArray<Item> = presets
    ? presetsInView(
        presetView,
        search,
        all.map((item) => item.entry),
        archived
      ).map((entry) => ({
        entry,
        card: undefined,
        usage: undefined,
        shell: undefined,
        detail: presetDetail(entry, presetView)
      }))
    : shown
        .filter((item) => matches(needle, item.entry.label, item.entry.subtitle, item.entry.modelName))
        .sort(cards ? compareItems(prefs.sort, prefs.reversed) : byName)
  const personas = all.filter(persona).length
  const noun = presets && presetView === "archived" ? `archived ${title.toLowerCase()}` : title.toLowerCase()
  const total = presets && presetView === "archived" ? archived.length : all.length
  if (all.length === 0 && archived.length === 0)
    return (
      <EmptyState title={`No ${noun} yet`}>
        <Tooltip label="Opens file import.">
          <Link to="/import" className="text-accent">
            Import files to add some.
          </Link>
        </Tooltip>
      </EmptyState>
    )
  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label={`Search ${noun}`}
          placeholder={cards ? "Search by name, version or nickname" : "Search by name"}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          className="min-w-0 flex-1 basis-60"
        />
        {presets && (
          <Segmented<PresetView>
            label="Show presets"
            value={presetView}
            onValueChange={(next) => {
              setPresetView(next, true)
              if (next !== "archived" && next !== views.prefs.presetSort) void views.change({ presetSort: next })
            }}
            options={PRESET_VIEWS.map((option) => ({
              value: option.value,
              description: option.description,
              label:
                option.value === "archived" && archived.length > 0
                  ? `${option.label} · ${archived.length}`
                  : option.label
            }))}
          />
        )}
        {cards && (
          <Segmented
            label="Show"
            value={prefs.show}
            onValueChange={(show) => setPrefs({ show })}
            options={[
              { value: "all", label: "All" },
              { value: "characters", label: "Characters", description: "Cards outside the persona folder." },
              {
                value: "personas",
                label: `Personas · ${personas}`,
                description: "Cards in the persona folder, offered when you pick who you play."
              }
            ]}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted" aria-live="polite">
          {items.length === total
            ? `${total.toLocaleString()} ${noun}`
            : `${items.length.toLocaleString()} of ${total.toLocaleString()} ${noun}`}
        </p>
        {cards && (
          <div className="flex items-center gap-2">
            <Field label={<span className="sr-only">Sort cards</span>} className="w-36 shrink-0">
              <Select<Sort>
                items={[
                  {
                    value: "used",
                    label: "Last used",
                    description: "By the last message the card wrote, in any chat; unused cards come last"
                  },
                  { value: "name", label: "Name", description: "By name" },
                  { value: "chats", label: "Most chats", description: "By how many chats it's in" },
                  {
                    value: "changed",
                    label: "Recently changed",
                    description: "By when the card last changed: saved, imported, updated or renamed"
                  },
                  {
                    value: "added",
                    label: "Added",
                    description: "By when it was added; a folder import keeps the date it was added there"
                  }
                ]}
                value={prefs.sort}
                onValueChange={(sort) => setPrefs({ sort })}
              />
            </Field>
            <SortDirection
              order={prefs.sort === "name" ? "name" : prefs.sort === "chats" ? "count" : "date"}
              reversed={prefs.reversed}
              onToggle={() => setPrefs({ reversed: !prefs.reversed })}
            />
            <Segmented
              label="View"
              value={prefs.view}
              onValueChange={(view) => setPrefs({ view })}
              options={[
                { value: "list", label: "List" },
                { value: "grid", label: "Grid" }
              ]}
            />
          </div>
        )}
      </div>
      {items.length === 0 ? (
        <EmptyState title={needle ? `No ${noun} match “${search.trim()}”` : `No ${noun} here`}>
          {needle && (
            <Button hint="Clears the library search." variant="ghost" onClick={() => setSearch("")}>
              Clear the search
            </Button>
          )}
        </EmptyState>
      ) : (
        <Items title={title} items={items} view={cards ? prefs.view : "list"} formats={formats} />
      )}
    </div>
  )
}

export function LibraryPage() {
  useTitle("Library")
  const [prefs, setPrefs] = usePrefs()
  const shell = useAtomValue(shellAtom)
  const usage = new Map(
    AsyncResult.isSuccess(shell) ? [...shell.value.cards, ...shell.value.personas].map((c) => [c.card.entityId, c]) : []
  )
  return (
    <div className="flex flex-col gap-5">
      <CenterHeaderContent>
        <h1 className="text-base font-semibold">Library</h1>
      </CenterHeaderContent>
      <div className="flex flex-wrap gap-2">
        <SlotOutlet slot={libraryActions} props={{ kind: prefs.kind, personas: prefs.show === "personas" }} />
        <Tooltip label="Opens file import.">
          <Link to="/import" className={buttonClass("primary")}>
            Import files
          </Link>
        </Tooltip>
      </div>
      <SlotOutlet slot={libraryPanels} props={{ kind: prefs.kind }} />
      <AsyncView atom={libraryAtom} loading="Loading the library…">
        {(lists) => {
          const cards = new Map(lists.castCards.map((card) => [card.entityId, card]))
          return (
            <Tabs
              label="Library sections"
              value={prefs.kind}
              onValueChange={(kind) => setPrefs({ kind })}
              tabs={LISTED.map(({ kind, title }) => ({
                value: kind,
                label: `${title} · ${lists[kind].length.toLocaleString()}`,
                panel: (
                  <Section
                    kind={kind}
                    title={title}
                    all={lists[kind].map((entry) => ({
                      entry,
                      card: cards.get(entry.entityId),
                      usage: usage.get(entry.entityId)?.card,
                      shell: cards.get(entry.entityId)?.persona ? undefined : usage.get(entry.entityId)
                    }))}
                    {...(kind === "preset" ? { archived: lists.archivedPresets } : {})}
                    prefs={prefs}
                    setPrefs={setPrefs}
                    formats={lists.exportFormats}
                  />
                )
              }))}
            />
          )
        }}
      </AsyncView>
    </div>
  )
}
