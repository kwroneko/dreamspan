// A lorebook's entries as a table, as SillyTavern's World Info editor shows them: one row per
// entry with its switch, title and keys, and the registered columns (strategy, position,
// depth, order, trigger %) edited in place; a row opens to the whole entry (EntryDetails).
// Rows are virtualized, so a book of hundreds of entries stays fast; the order is fixed when
// the search, filter or sort changes, so a row never jumps away while it's edited.
import type { LorebookDoc, LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import { type FieldPath, getAt, parseField, valueField } from "@rp/shared/editing.ts"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType
} from "react"
import type { Registry } from "../../registry.ts"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Select } from "../../ui/Select.tsx"
import { iconButtonClass } from "../../ui/Tooltip.tsx"
import { EntryDetails } from "./LorebookEntryDetails.tsx"
import {
  addEntry,
  arrangeEntries,
  type EnabledFilter,
  entryPath,
  type LorebookActionProps,
  type LorebookColumn,
  lorebookColumns,
  type LorebookEntryAction,
  type LorebookEntryContext,
  lorebookEntryActions,
  lorebookSorts,
  uidOf
} from "./lorebookTable.ts"
import { SearchNavigation, useSearchMatch } from "./searchNavigation.ts"
import { type EditorStore, useEditorKind, useText, useValue } from "./store.ts"

/** Below this width the cells wrap under the title, labelled, instead of standing in columns. */
const WIDE = 760

const useRegistry = <A extends { readonly id: string; readonly order: number }>(registry: Registry<A>) => {
  const snapshot = useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot)
  return [...snapshot.entries].sort((a, b) => a.order - b.order)
}

/** The nearest ancestor that scrolls: the page's main column, or the chat's editor overlay. */
const scrollParent = (element: HTMLElement | null) => {
  for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent)
    if (overflowY === "auto" || overflowY === "scroll") return parent
  }
  return null
}

const entriesLabel = (count: number) => `${count.toLocaleString()} ${count === 1 ? "entry" : "entries"}`

/** The title, edited in place, and the keys at a glance; a click on them opens the entry at its keys. */
function TitleCell({
  store,
  path,
  entry,
  title,
  uid,
  onKeys
}: LorebookEntryContext & { uid: number; onKeys: () => void }) {
  const titlePath = [...path, "comment"]
  const text = useText(store, titlePath)
  const match = useSearchMatch(titlePath)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!match) return
    const frame = requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(match.at, match.at + match.length)
    })
    return () => cancelAnimationFrame(frame)
  }, [match])
  const keys = entry.keys.join(", ")
  return (
    <div className="flex min-w-0 flex-col">
      <Input
        ref={input}
        id={`lore-title-${uid}`}
        aria-label={`Title of ${title}`}
        placeholder="Untitled entry"
        className="h-8! px-2! font-medium"
        value={text}
        onChange={(event) => store.setText(titlePath, event.currentTarget.value)}
        onBlur={() => void store.save(JSON.stringify(titlePath))}
      />
      <button
        type="button"
        onClick={onKeys}
        className="mt-0.5 truncate rounded-sm px-2 text-left text-xs text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
        aria-label={`Keys of ${title}: ${keys || "none"}. Open the entry to edit them.`}
      >
        {keys ? keys : entry.constant ? "No keys · always included" : "No keys"}
      </button>
    </div>
  )
}

/**
 * A row's ⋯ menu. A plain button until first used, then the menu, mounted open: hundreds of
 * rows each holding a menu would make scrolling slow.
 */
function RowActions({
  context,
  actions,
  onPick
}: {
  context: LorebookEntryContext
  actions: ReadonlyArray<LorebookEntryAction>
  onPick: (action: LorebookEntryAction) => void
}) {
  const [mounted, setMounted] = useState(false)
  const label = `More for ${context.title}`
  const button = (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={iconButtonClass()}
      onClick={() => setMounted(true)}
    >
      <Icon name="more" />
    </button>
  )
  if (!mounted) return button
  return (
    <Menu
      label={`Actions for ${context.title}`}
      defaultOpen
      onOpenChange={(open) => !open && setMounted(false)}
      trigger={<button type="button" aria-label={label} title={label} className={iconButtonClass()} />}
    >
      {actions.map((action, index) => (
        <span key={action.id} className="contents">
          {action.tone === "danger" && index > 0 && <MenuSeparator />}
          <MenuItem
            {...(action.tone ? { tone: action.tone } : {})}
            {...(action.icon ? { icon: action.icon } : {})}
            onClick={() => onPick(action)}
          >
            {action.label}
          </MenuItem>
        </span>
      ))}
    </Menu>
  )
}

interface RowProps {
  store: EditorStore
  root: FieldPath
  uid: number
  open: boolean
  wide: boolean
  card: boolean
  template: string
  columns: ReadonlyArray<LorebookColumn>
  actions: ReadonlyArray<LorebookEntryAction>
  onToggle: (uid: number, open: boolean, focus?: "keys") => void
  onAction: (uid: number, action: LorebookEntryAction) => void
}

const EntryRow = memo(function EntryRow({
  store,
  root,
  uid,
  open,
  wide,
  card,
  template,
  columns,
  actions,
  onToggle,
  onAction
}: RowProps) {
  const path = entryPath(root, uid)
  const entry = useValue<LorebookEntry | undefined>(store, path)
  const typed = useText(store, [...path, "comment"])
  if (!entry) return null
  const title = typed || "Untitled entry"
  const context: LorebookEntryContext = { store, root, entry, path, title }
  const toggleLabel = open ? `Close ${title}` : `Open ${title}`
  const chevron = (
    <button
      type="button"
      aria-label={toggleLabel}
      title={toggleLabel}
      aria-expanded={open}
      className={iconButtonClass()}
      onClick={() => onToggle(uid, !open)}
    >
      <Icon name="down" className={`transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`} />
    </button>
  )
  const enabled = (
    <Switch checked={entry.enabled} onCheckedChange={(next) => store.setValue([...path, "enabled"], next)}>
      <span className="sr-only">{`${title} enabled`}</span>
    </Switch>
  )
  const titleCell = <TitleCell {...context} uid={uid} onKeys={() => onToggle(uid, true, "keys")} />
  const menu = <RowActions context={context} actions={actions} onPick={(action) => onAction(uid, action)} />
  return (
    <div
      className={`border-b border-border py-1.5 ${entry.enabled ? "" : "[&_input]:text-muted"} ${open ? "bg-surface" : ""}`}
    >
      {wide ? (
        <div className="grid items-start gap-2 px-1" style={{ gridTemplateColumns: template }}>
          <div className="flex items-center gap-1 pt-0.5">
            {chevron}
            <span className="pt-1">{enabled}</span>
          </div>
          {titleCell}
          {columns.map((column) => (
            <div key={column.id} className="min-w-0">
              <column.cell {...context} />
            </div>
          ))}
          <div className="flex justify-end">{menu}</div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 px-1">
          <div className="flex items-start gap-1">
            {chevron}
            <span className="pt-1.5">{enabled}</span>
            <div className="min-w-0 flex-1">{titleCell}</div>
            {menu}
          </div>
          <div className="flex flex-wrap gap-x-2 gap-y-1.5 pl-9">
            {columns.map((column) => (
              <label key={column.id} className="flex min-w-0 flex-col gap-0.5 text-xs text-muted">
                {column.header}
                <span style={{ width: column.width }} className="block text-sm text-text">
                  <column.cell {...context} />
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      {open && (
        <div className="px-2 pt-3 pb-4 sm:px-3">
          <EntryDetails store={store} root={root} uid={uid} wide={wide} card={card} />
        </div>
      )}
    </div>
  )
})

/**
 * The rows in view, positioned by the virtualizer. The virtualizer is a mutable instance the
 * compiler can't memoize, so it lives here, apart from the table's memoized callbacks.
 */
function Rows({
  uids,
  scroller,
  margin,
  focus,
  onFocused,
  searching,
  row,
  opened
}: {
  uids: ReadonlyArray<number>
  scroller: HTMLElement | null
  margin: number
  focus: { uid: number; at: "title" | "keys" } | null
  onFocused: () => void
  /** A search visit focuses its own field. */
  searching: boolean
  row: Omit<RowProps, "uid" | "open">
  opened: ReadonlySet<number>
}) {
  "use no memo"
  // eslint-disable-next-line react-hooks/incompatible-library -- mutable instance; memoization is disabled above
  const virtualizer = useVirtualizer({
    count: uids.length,
    getScrollElement: () => scroller,
    estimateSize: () => (row.wide ? 63 : 112),
    overscan: 10,
    scrollMargin: margin,
    getItemKey: (index) => uids[index]!
  })
  // Scroll to a revealed entry, then focus where it was opened at.
  useEffect(() => {
    if (!focus) return
    const index = uids.indexOf(focus.uid)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "start" })
    const frame = requestAnimationFrame(() => {
      if (!searching)
        document.getElementById(focus.at === "keys" ? `lore-keys-${focus.uid}` : `lore-title-${focus.uid}`)?.focus()
      onFocused()
    })
    return () => cancelAnimationFrame(frame)
  }, [focus, uids, virtualizer, searching, onFocused])
  return (
    <div
      role="list"
      aria-label="Entries"
      className="relative [contain:strict]"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          role="listitem"
          data-index={item.index}
          ref={virtualizer.measureElement}
          className="absolute top-0 left-0 w-full [contain:layout_style]"
          style={{ transform: `translateY(${item.start - margin}px)` }}
        >
          <EntryRow {...row} uid={uids[item.index]!} open={opened.has(uids[item.index]!)} />
        </div>
      ))}
    </div>
  )
}

/** Entries removed as a draft, with the way back until the book is saved. */
function Removed({ store, root, uids }: { store: EditorStore; root: FieldPath; uids: ReadonlyArray<number> }) {
  if (uids.length === 0) return null
  const saved = (getAt(store.head, [...root, "entries"]) ?? []) as ReadonlyArray<LorebookEntry>
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2 text-sm"
    >
      <span className="text-muted">Deleted, until you save:</span>
      {uids.map((uid) => {
        const title = saved.find((entry) => entry.uid === uid)?.comment || "Untitled entry"
        return (
          <span key={uid} className="inline-flex items-center gap-1">
            <span className="[overflow-wrap:anywhere]">{title}</span>
            <Button
              variant="ghost"
              className="h-7! px-2!"
              aria-label={`Restore ${title}`}
              onClick={() => void store.discard(valueField(entryPath(root, uid)))}
            >
              Restore
            </Button>
          </span>
        )
      })}
    </div>
  )
}

/** The entries whose fields have changes: dirty drafts under `root`'s entries. */
const changedUids = (store: EditorStore, root: FieldPath) =>
  new Set(
    store.dirtyFields().flatMap((key) => {
      const path = parseField(key)?.path
      if (!path || path.length <= root.length + 1 || path[root.length] !== "entries") return []
      const uid = uidOf(path[root.length + 1])
      return uid === null ? [] : [uid]
    })
  )

export function LorebookTable({
  store,
  root,
  book,
  added = null
}: {
  store: EditorStore
  root: FieldPath
  book: LorebookDoc
  /** An entry added before the table showed (a card's first, which makes its book): shown open. */
  added?: number | null
}) {
  const columns = useRegistry(lorebookColumns)
  const sorts = useRegistry(lorebookSorts)
  const actions = useRegistry(lorebookEntryActions)
  const card = useEditorKind(store) === "card"
  const [query, setQuery] = useState("")
  const [enabled, setEnabled] = useState<EnabledFilter>("all")
  const [sortId, setSortId] = useState("order")
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set(added === null ? [] : [added]))
  // An entry just added leads the table until the search, filter or sort changes.
  const [first, setFirst] = useState<number | null>(added)
  const [focus, setFocus] = useState<{ uid: number; at: "title" | "keys" } | null>(
    added === null ? null : { uid: added, at: "title" }
  )
  const [dialog, setDialog] = useState<{ uid: number; action: ComponentType<LorebookActionProps> } | null>(null)
  const sort = sorts.find((s) => s.id === sortId) ?? sorts[0]

  // The order is worked out when what decides it changes, not on every edit.
  const signature = book.entries.map((entry) => entry.uid).join(",")
  const orderKey = JSON.stringify([signature, query, enabled, sort?.id, first])
  const arrange = () => {
    const changed = changedUids(store, root)
    return arrangeEntries(book.entries, {
      query,
      enabled,
      sort,
      first,
      facts: (entry, index) => {
        const path = entryPath(root, entry.uid)
        return {
          index,
          title: store.text([...path, "comment"]),
          content: store.text([...path, "content"]),
          changed: changed.has(entry.uid)
        }
      }
    })
  }
  const [arranged, setArranged] = useState(() => ({ key: orderKey, uids: arrange() }))
  let uids = arranged.uids
  if (arranged.key !== orderKey) {
    uids = arrange()
    setArranged({ key: orderKey, uids })
  }

  // A search visit to an entry: everything shown again, the entry open and scrolled to.
  const match = useContext(SearchNavigation)
  const [visited, setVisited] = useState(match)
  if (match !== visited) {
    setVisited(match)
    const at = match && JSON.stringify(match.path.slice(0, root.length + 1)) === JSON.stringify([...root, "entries"])
    const uid = at ? uidOf(match.path[root.length + 1]) : null
    if (uid !== null) {
      setQuery("")
      setEnabled("all")
      setOpened((set) => new Set(set).add(uid))
      setFocus({ uid, at: "title" })
    }
  }

  // Measured, so the chat's narrow editor overlay gets the narrow layout too.
  const list = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const scroll = scrollParent(element)
    setScroller(scroll)
    const measure = () => {
      setWidth(element.offsetWidth)
      if (scroll) setMargin(element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (scroll?.firstElementChild) observer.observe(scroll.firstElementChild)
    measure()
    return () => observer.disconnect()
  }, [])
  const wide = width === 0 || width >= WIDE
  const template = `4.5rem minmax(10rem,1fr) ${columns.map((column) => column.width).join(" ")} 2.25rem`

  const toggle = (uid: number, open: boolean, at?: "keys") => {
    setOpened((set) => {
      const next = new Set(set)
      if (open) next.add(uid)
      else next.delete(uid)
      return next
    })
    if (at) setFocus({ uid, at })
  }
  const reveal = (uid: number) => {
    setQuery("")
    setEnabled("all")
    setFirst(uid)
    setOpened((set) => new Set(set).add(uid))
    setFocus({ uid, at: "title" })
  }
  const runAction = (uid: number, action: LorebookEntryAction) => {
    const path = entryPath(root, uid)
    const entry = store.value(path) as LorebookEntry | undefined
    if (!entry) return
    if (action.dialog) return setDialog({ uid, action: action.dialog })
    const title = store.text([...path, "comment"]) || "Untitled entry"
    action.run?.({ store, root, entry, path, title, book: store.value(root) as LorebookDoc, reveal })
  }

  const savedUids = ((getAt(store.head, [...root, "entries"]) ?? []) as ReadonlyArray<LorebookEntry>).map(
    (entry) => entry.uid
  )
  const removed = savedUids.filter((uid) => !book.entries.some((entry) => entry.uid === uid))
  const dialogEntry = dialog ? (store.value(entryPath(root, dialog.uid)) as LorebookEntry | undefined) : undefined
  const filtered = query.trim() !== "" || enabled !== "all"

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={() => {
              const uid = addEntry(store, root, book)
              reveal(uid)
            }}
          >
            <Icon name="insert" />
            Add entry
          </Button>
          <div className="min-w-[12rem] flex-1">
            <Input
              type="search"
              aria-label="Search titles, keys and content"
              placeholder="Search titles, keys and content"
              value={query}
              onChange={(event) => {
                setFirst(null)
                setQuery(event.currentTarget.value)
              }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Show"
            value={enabled}
            onValueChange={(next) => {
              setFirst(null)
              setEnabled(next)
            }}
            options={[
              { value: "all", label: "All" },
              { value: "on", label: "Enabled" },
              { value: "off", label: "Disabled" }
            ]}
          />
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">Sort by</span>
            <div className="w-44">
              <Select
                ariaLabel="Sort entries by"
                items={sorts.map((s) => ({ value: s.id, label: s.label }))}
                value={sort?.id ?? null}
                onValueChange={(next) => {
                  setFirst(null)
                  setSortId(next)
                }}
              />
            </div>
          </div>
          <span className="flex-1" />
          {opened.size > 0 && (
            <Button variant="ghost" className="h-8!" onClick={() => setOpened(new Set())}>
              Close all
            </Button>
          )}
          <p role="status" className="text-sm text-muted">
            {filtered
              ? `${uids.length.toLocaleString()} of ${entriesLabel(book.entries.length)}`
              : entriesLabel(book.entries.length)}
          </p>
        </div>
        <Removed store={store} root={root} uids={removed} />
      </div>

      <div ref={list} className="min-w-0 rounded-lg border border-border bg-canvas">
        {wide && uids.length > 0 && (
          <div
            aria-hidden="true"
            className="grid gap-2 border-b border-border px-1 py-1.5 text-xs font-medium text-muted"
            style={{ gridTemplateColumns: template }}
          >
            <span className="pl-1">On</span>
            <span className="pl-2">Title · keys</span>
            {columns.map((column) => (
              <span key={column.id} className="pl-1">
                {column.header}
              </span>
            ))}
            <span />
          </div>
        )}
        {uids.length === 0 ? (
          <p className="p-4 text-sm text-muted">
            {book.entries.length === 0 ? "No entries yet." : "No entry matches."}
          </p>
        ) : (
          <Rows
            uids={uids}
            scroller={scroller}
            margin={margin}
            focus={focus}
            onFocused={() => setFocus(null)}
            searching={match !== null}
            row={{ store, root, wide, card, template, columns, actions, onToggle: toggle, onAction: runAction }}
            opened={opened}
          />
        )}
      </div>

      {dialog && dialogEntry && (
        <dialog.action
          store={store}
          root={root}
          entry={dialogEntry}
          path={entryPath(root, dialog.uid)}
          title={store.text([...entryPath(root, dialog.uid), "comment"]) || "Untitled entry"}
          book={store.value(root) as LorebookDoc}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}
