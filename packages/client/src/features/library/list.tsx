// The library: every card, lorebook and preset, found by name and opened from here. Each
// item shows what identifies it, a direct action or two, and the rest in its menu.
import { useAtomValue } from "@effect/atom-react"
import type { CastCard } from "@rp/shared/chat.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import type { ExportFormatInfo } from "@rp/shared/libraryImport.ts"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useRef, useState, type ReactNode } from "react"
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
import { FavouriteStar } from "../characters/cardBrowse.tsx"
import { shellAtom, type ShellLibrary } from "../characters/shellData.tsx"
import { useTitle } from "../shell.tsx"
import { LISTED, libraryAtom } from "./data.ts"
import { itemName, LibraryItemActions } from "./itemActions.tsx"
import { libraryActions } from "./slots.ts"

type Kind = (typeof LISTED)[number]["kind"]
type Show = "all" | "characters" | "personas"
type Sort = "used" | "name" | "chats" | "changed"
type View = "list" | "grid"
interface Prefs {
  readonly kind: Kind
  readonly show: Show
  readonly sort: Sort
  readonly view: View
}
const DEFAULTS: Prefs = { kind: "card", show: "all", sort: "used", view: "list" }

/** The page's choices, remembered per account in this browser. */
function usePrefs() {
  const key = `rp.library.${useSession().user.id}`
  const [prefs, setPrefs] = useState<Prefs>(() => {
    try {
      return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<Prefs>) }
    } catch {
      return DEFAULTS
    }
  })
  const update = (change: Partial<Prefs>) => {
    const next = { ...prefs, ...change }
    setPrefs(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      /* Not remembered, still applied. */
    }
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
  /** A character's shell card (not a persona's), for its favourite star. */
  readonly shell: ShellCard | undefined
}
type ShellCard = ShellLibrary["cards"][number]
const persona = (item: Item) => item.card?.persona === true

const SORTS: Record<Sort, (a: Item, b: Item) => number> = {
  used: (a, b) => (b.usage?.lastMessageAt ?? -1) - (a.usage?.lastMessageAt ?? -1),
  name: () => 0,
  chats: (a, b) => (b.usage?.chats ?? -1) - (a.usage?.chats ?? -1),
  changed: (a, b) => b.entry.updatedAt - a.entry.updatedAt
}
const byName = (a: Item, b: Item) =>
  a.entry.label.localeCompare(b.entry.label) || a.entry.subtitle.localeCompare(b.entry.subtitle)

const matches = (needle: string, ...texts: ReadonlyArray<string | undefined>) =>
  texts.some((text) => text?.toLowerCase().includes(needle))

/** What an item says under its name: its version, then how it's used. */
function Meta({ item }: { item: Item }) {
  // A persona's badge says what it is; the shell doesn't count the chats it plays in.
  const usage = !persona(item) && item.usage ? usageLine(item.usage) : null
  return (
    <>
      {item.entry.subtitle && <span>{item.entry.subtitle}</span>}
      {item.entry.subtitle && usage && " · "}
      {usage}
    </>
  )
}

function Badges({ item, seen }: { item: Item; seen: boolean }) {
  const { entry } = item
  return (
    <>
      {persona(item) && <Badge tone="accent">Persona</Badge>}
      {entry.kind !== "card" && entry.refKind === "variant" && <Badge>variant</Badge>}
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
  const props = picture ? { tabIndex: -1, "aria-hidden": true, className } : { title: itemName(entry), className }
  return entry.kind === "card" && !persona(item) ? (
    <Link to="/cards/$entityId" params={{ entityId: entry.entityId }} {...props}>
      {children}
    </Link>
  ) : (
    <Link to="/library/$refId" params={{ refId: entry.id }} {...props}>
      {children}
    </Link>
  )
}
const nameLink =
  "rounded-sm font-medium outline-none [overflow-wrap:anywhere] hover:underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-focus"

function Picture({ item, size }: { item: Item; size: "lg" | "fill" }) {
  const { entry } = item
  if (entry.kind === "card")
    return <Avatar id={entry.entityId} name={entry.label} mediaId={item.card?.avatarMediaId ?? null} size={size} />
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
  const line = entry.kind === "card" || entry.subtitle !== "" || entry.refKind === "variant" || entry.updateAvailable
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
        <span className="col-span-2 col-start-2 row-start-2 flex min-w-0 items-center gap-1.5 self-start text-xs text-muted sm:col-span-1">
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
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface [contain-intrinsic-size:auto_22rem] [content-visibility:auto]"
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
        <div className="mt-auto flex items-center justify-end gap-0.5 pt-1">
          {item.shell && <FavouriteStar card={item.shell} />}
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
  prefs,
  setPrefs,
  formats
}: {
  kind: Kind
  title: string
  all: ReadonlyArray<Item>
  prefs: Prefs
  setPrefs: (change: Partial<Prefs>) => void
  formats: ReadonlyArray<ExportFormatInfo>
}) {
  const [search, setSearch] = useState("")
  const needle = search.trim().toLowerCase()
  const cards = kind === "card"
  const shown = cards
    ? all.filter((item) => prefs.show === "all" || (prefs.show === "personas") === persona(item))
    : all
  const items = shown
    .filter((item) => matches(needle, item.entry.label, item.entry.subtitle, item.entry.modelName))
    .sort((a, b) => (cards ? SORTS[prefs.sort](a, b) : 0) || byName(a, b))
  const personas = all.filter(persona).length
  const noun = title.toLowerCase()
  if (all.length === 0)
    return (
      <EmptyState title={`No ${noun} yet`}>
        <Link to="/import" className="text-accent">
          Import files to add some.
        </Link>
      </EmptyState>
    )
  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label={`Search ${noun}`}
          placeholder={cards ? "Search by name, version or in-chat name" : "Search by name"}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          className="min-w-0 flex-1 basis-60"
        />
        {cards && (
          <Segmented
            label="Show"
            value={prefs.show}
            onValueChange={(show) => setPrefs({ show })}
            options={[
              { value: "all", label: "All" },
              { value: "characters", label: "Characters" },
              { value: "personas", label: `Personas · ${personas}` }
            ]}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted" aria-live="polite">
          {items.length === all.length
            ? `${all.length.toLocaleString()} ${noun}`
            : `${items.length.toLocaleString()} of ${all.length.toLocaleString()} ${noun}`}
        </p>
        {cards && (
          <div className="flex items-center gap-2">
            <Field label={<span className="sr-only">Sort cards</span>} className="w-36 shrink-0">
              <Select<Sort>
                items={[
                  { value: "used", label: "Last used" },
                  { value: "name", label: "Name" },
                  { value: "chats", label: "Most chats" },
                  { value: "changed", label: "Recently changed" }
                ]}
                value={prefs.sort}
                onValueChange={(sort) => setPrefs({ sort })}
              />
            </Field>
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
            <Button variant="ghost" onClick={() => setSearch("")}>
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
  const usage = new Map(AsyncResult.isSuccess(shell) ? shell.value.cards.map((c) => [c.card.entityId, c]) : [])
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Library</h1>
        <div className="flex flex-wrap gap-2">
          <SlotOutlet slot={libraryActions} props={{}} />
          <Link to="/import" className={buttonClass("primary")}>
            Import files
          </Link>
        </div>
      </header>
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
                      shell: usage.get(entry.entityId)
                    }))}
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
