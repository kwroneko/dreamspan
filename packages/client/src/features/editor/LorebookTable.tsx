import { usePlaceParam, usePlaceNotice } from "../../usePlaceParam.ts"
// A lorebook's entries as a table, as SillyTavern's World Info editor shows them: one row per
// entry with its switch, title and keys, and the registered columns (strategy, position,
// depth, order, trigger %) edited in place; a row opens to its text and keys, with the rest
// under its Settings (EntryDetails). In the side panel and on a narrow screen a row is a compact
// header instead: the keys under the title and a few badges for what matters most, the columns
// moving into the entry's Settings. Rows are virtualized, so a book of hundreds of entries
// stays fast; the order is fixed when the search, filter or sort changes, so a row never
// jumps away while it's edited.
import { rowActionInsetClass } from "../../ui/rowSpacing.ts"
import type { LorebookDoc, LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import { type FieldPath, getAt, parseField, valueField } from "@rp/shared/editing.ts"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  memo,
  type ReactNode,
  useContext,
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType
} from "react"
import type { Registry } from "../../registry.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox, Switch } from "../../ui/Choice.tsx"
import { Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.tsx"
import { revealIfHidden } from "../../ui/reveal.ts"
import { Segmented } from "../../ui/Segmented.tsx"
import { Select } from "../../ui/Select.tsx"
import { iconButtonClass, Tooltip } from "../../ui/Tooltip.tsx"
import { EntryDetails, KeysLine } from "./LorebookEntryDetails.tsx"
import { BlockOptionsToggle } from "../../ui/Block.tsx"
import { EXPLAIN } from "./lorebookExplain.ts"
import { applyMassChange, enableAllEdits } from "./lorebookMass.ts"
import { MassEditDialog } from "./LorebookMassEdit.tsx"
import { useOpenEntries } from "./lorebookOpen.ts"
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
  POSITIONS,
  positionValue,
  uidOf
} from "./lorebookTable.ts"
import { SearchNavigation, useSearchMatch } from "./searchNavigation.ts"
import { type EditorStore, useEditorKind, useText, useValue } from "./store.ts"

/** What an opened entry shows with its settings closed. */
const SHOWN: ReadonlySet<string> = new Set(["comment", "keys", "content"])

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

/**
 * The title, edited in place, and the keys at a glance: closed, a click on them opens the entry
 * at its keys; open, they're edited where they are.
 */
function TitleCell({
  store,
  path,
  entry,
  title,
  uid,
  idPrefix,
  open,
  onKeys,
  badges
}: LorebookEntryContext & { uid: number; idPrefix: string; open: boolean; onKeys: () => void; badges?: ReactNode }) {
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
  const noKeys = entry.constant
    ? "No keys · always included"
    : entry.vectorized
      ? "No keys · by similarity"
      : "No keys · never matched"
  return (
    <div className="flex min-w-0 flex-col">
      <Input
        ref={input}
        id={`${idPrefix}-title-${uid}`}
        aria-label={`Title of ${title}`}
        placeholder="Untitled entry"
        className="h-8! px-2! font-medium"
        value={text}
        onChange={(event) => store.setText(titlePath, event.currentTarget.value)}
        onBlur={() => void store.save(JSON.stringify(titlePath))}
      />
      {open ? (
        <KeysLine
          store={store}
          path={[...path, "keys"]}
          id={`${idPrefix}-keys-${uid}`}
          empty={noKeys}
          badges={badges}
        />
      ) : (
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <Tooltip label="Its primary keys: one appearing in the chat sends it. Click to open the entry at them.">
            <button
              type="button"
              onClick={onKeys}
              className="max-w-full min-w-0 truncate rounded-sm px-2 text-left text-xs text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
              aria-label={`Keys of ${title}: ${keys || "none"}. Open the entry to edit them.`}
            >
              {keys || noKeys}
            </button>
          </Tooltip>
          {badges}
        </div>
      )}
    </div>
  )
}

/** A short fact about an entry beside its keys, explained on hover. */
function Chip({ label, hint, tone = "muted" }: { label: string; hint: string; tone?: "muted" | "accent" }) {
  return (
    <Tooltip label={hint}>
      <span
        className={`inline-flex h-5 max-w-full shrink-0 items-center truncate rounded-full border px-1.5 text-[11px] leading-none ${
          tone === "accent" ? "border-accent/40 text-accent" : "border-border text-muted"
        }`}
      >
        {label}
      </span>
    </Tooltip>
  )
}

/**
 * The essentials a compact header shows (owner, 2026-11-01: "minimal and/or clever"): a strategy
 * that isn't the usual key match, where it goes (with its depth and, if not system, its role),
 * a trigger % that isn't 100, and secondary keys only when they're used. Order, matching,
 * groups, recursion and timing wait in the entry's Settings.
 */
function EntryBadges({ entry }: { entry: LorebookEntry }) {
  const position = POSITIONS.find((item) => item.value === positionValue(entry))
  const chips: Array<ReactNode> = []
  if (entry.constant) chips.push(<Chip key="s" label="Constant" tone="accent" hint={EXPLAIN.constant} />)
  else if (entry.vectorized) chips.push(<Chip key="s" label="Vector" tone="accent" hint={EXPLAIN.vectorized} />)
  if (position)
    chips.push(
      <Chip
        key="p"
        label={
          entry.position === "at_depth"
            ? `@D ${entry.depth}${entry.role === "system" ? "" : ` ${entry.role}`}`
            : position.short
        }
        hint={`${position.label}: ${position.description} ${EXPLAIN.position}`}
      />
    )
  if (entry.use_probability && entry.probability < 100)
    chips.push(<Chip key="t" label={`${entry.probability}%`} hint={EXPLAIN.probability} />)
  if (entry.selective && entry.secondary_keys.length > 0)
    chips.push(
      <Chip
        key="k"
        label={`${entry.selective_logic.replace("_", " ").toUpperCase()}: ${entry.secondary_keys.join(", ")}`}
        hint={EXPLAIN.selective_logic}
      />
    )
  return chips.length > 0 ? <>{chips}</> : null
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
            description={action.description}
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
  idPrefix: string
  open: boolean
  /** Its settings are open. */
  settings: boolean
  wide: boolean
  /** A compact header (the side panel, a narrow screen): badges, and the columns in Settings. */
  compact: boolean
  card: boolean
  template: string
  columns: ReadonlyArray<LorebookColumn>
  actions: ReadonlyArray<LorebookEntryAction>
  /** Selection mode: each row has its checkbox. */
  selecting: boolean
  selected: boolean
  onSelect: (uid: number, selected: boolean) => void
  onToggle: (uid: number, open: boolean, focus?: "keys") => void
  onSettings: (uid: number, open: boolean) => void
  onAction: (uid: number, action: LorebookEntryAction) => void
}

/** The row's columns, labelled, where its header doesn't show them: in the entry's Settings. */
function Essentials({ columns, context }: { columns: ReadonlyArray<LorebookColumn>; context: LorebookEntryContext }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-2">
      {columns.map((column) => (
        <label key={column.id} className="flex min-w-0 flex-col gap-0.5 text-xs text-muted">
          {column.header}
          <span style={{ width: column.width }} className="block text-sm text-text">
            <column.cell {...context} />
          </span>
        </label>
      ))}
    </div>
  )
}

const EntryRow = memo(function EntryRow({
  store,
  root,
  uid,
  idPrefix,
  open,
  settings,
  wide,
  compact,
  card,
  template,
  columns,
  actions,
  selecting,
  selected,
  onSelect,
  onSettings,
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
    <Tooltip label={open ? "Close the entry" : "Open the entry: its text, with its keys to edit"}>
      <button
        type="button"
        aria-label={toggleLabel}
        aria-expanded={open}
        className={iconButtonClass()}
        onClick={() => onToggle(uid, !open)}
      >
        <Icon
          name="down"
          className={`transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
        />
      </button>
    </Tooltip>
  )
  // Explained on hover and focus only: a phone would otherwise repeat it under every entry.
  const enabled = (
    <Tooltip label={EXPLAIN.enabled}>
      <span className="inline-flex">
        <Switch
          labelHidden
          checked={entry.enabled}
          onCheckedChange={(next) => store.setValue([...path, "enabled"], next)}
        >
          <span className="sr-only">{`${title} enabled`}</span>
        </Switch>
      </span>
    </Tooltip>
  )
  const select = selecting && (
    <Tooltip label="Selected entries change together: Change for selected…">
      <span className="inline-flex pt-1.5">
        <Checkbox checked={selected} onCheckedChange={(next) => onSelect(uid, next)}>
          <span className="sr-only">{`Select ${title}`}</span>
        </Checkbox>
      </span>
    </Tooltip>
  )
  const titleCell = (
    <TitleCell
      {...context}
      uid={uid}
      idPrefix={idPrefix}
      open={open}
      onKeys={() => onToggle(uid, true, "keys")}
      badges={compact ? <EntryBadges entry={entry} /> : undefined}
    />
  )
  const menu = <RowActions context={context} actions={actions} onPick={(action) => onAction(uid, action)} />
  // Like a preset prompt's options button: an opened entry's settings, above its text.
  const settingsToggle = open && (
    <BlockOptionsToggle
      open={settings}
      onToggle={() => onSettings(uid, !settings)}
      label={`Settings of ${title}`}
      hint={settings ? "Hide the entry's settings" : EXPLAIN.settings}
    />
  )
  return (
    <div
      {...(open ? { role: "group", "aria-label": `Lorebook entry ${uid}` } : {})}
      className={`border-b border-border py-2 ${entry.enabled ? "" : "[&_input]:text-muted"} ${open ? "bg-surface" : ""} ${selected ? "bg-accent/5" : ""}`}
    >
      {!compact ? (
        <div
          data-entry-header
          className={`grid items-start gap-2 ps-2 ${rowActionInsetClass} [--row-action-inset:1rem]`}
          style={{ gridTemplateColumns: template }}
        >
          <div className="mt-0.5 flex items-center gap-1">
            {select}
            {chevron}
            <span className="mt-1">{enabled}</span>
          </div>
          {titleCell}
          {columns.map((column) => (
            <div key={column.id} className="min-w-0">
              <column.cell {...context} />
            </div>
          ))}
          <div className="flex justify-end gap-0.5">
            {settingsToggle}
            {menu}
          </div>
        </div>
      ) : (
        <div
          data-entry-header
          className={`flex items-start gap-1 ps-2 ${rowActionInsetClass} [--row-action-inset:1rem]`}
        >
          {select}
          {chevron}
          <span className="mt-1.5">{enabled}</span>
          <div className="min-w-0 flex-1">{titleCell}</div>
          <div className="flex shrink-0 gap-0.5">
            {settingsToggle}
            {menu}
          </div>
        </div>
      )}
      {open && (
        <div className="px-2 pt-2 pb-2 sm:px-3">
          <EntryDetails
            store={store}
            root={root}
            uid={uid}
            wide={wide && !compact}
            card={card}
            settings={settings}
            essentials={compact ? <Essentials columns={columns} context={context} /> : undefined}
          />
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
  opened,
  settings,
  selected
}: {
  uids: ReadonlyArray<number>
  scroller: HTMLElement | null
  margin: number
  focus: { uid: number; at: "title" | "keys" } | null
  onFocused: () => void
  /** A search visit focuses its own field. */
  searching: boolean
  row: Omit<RowProps, "uid" | "open" | "settings" | "selected">
  opened: ReadonlySet<number>
  /** The opened entries whose settings are open. */
  settings: ReadonlySet<number>
  selected: ReadonlySet<number>
}) {
  "use no memo"
  // eslint-disable-next-line react-hooks/incompatible-library -- mutable instance; memoization is disabled above
  const virtualizer = useVirtualizer({
    count: uids.length,
    getScrollElement: () => scroller,
    estimateSize: () => (row.compact ? 66 : 63),
    overscan: 10,
    scrollMargin: margin,
    getItemKey: (index) => uids[index]!
  })
  // A revealed entry (added, duplicated, a search visit), then focus where it was opened at.
  // It scrolls only if its header or that field isn't in view (owner, 2026-11-02): an entry
  // added at the top usually is. One the list hasn't rendered is scrolled to first.
  useEffect(() => {
    if (!focus) return
    const index = uids.indexOf(focus.uid)
    const titleId = `${row.idPrefix}-title-${focus.uid}`
    if (index >= 0 && document.getElementById(titleId) === null) virtualizer.scrollToIndex(index, { align: "start" })
    let frame = 0
    let tries = 0
    const settle = () => {
      const field = document.getElementById(focus.at === "keys" ? `${row.idPrefix}-keys-${focus.uid}` : titleId)
      const header = document.getElementById(titleId)?.closest<HTMLElement>("[data-entry-header]")
      // Rendered a frame or two after the virtualizer scrolled.
      if (!header && ++tries < 4) return void (frame = requestAnimationFrame(settle))
      if (header) revealIfHidden(header, [field])
      if (!searching) field?.focus({ preventScroll: true })
      onFocused()
    }
    frame = requestAnimationFrame(settle)
    return () => cancelAnimationFrame(frame)
  }, [focus, uids, virtualizer, searching, onFocused, row.idPrefix])
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
          <EntryRow
            {...row}
            uid={uids[item.index]!}
            open={opened.has(uids[item.index]!)}
            settings={settings.has(uids[item.index]!)}
            selected={selected.has(uids[item.index]!)}
          />
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
              hint="Brings the entry back as it was saved."
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
  added = null,
  panel = false,
  tools,
  saveControls
}: {
  store: EditorStore
  root: FieldPath
  book: LorebookDoc
  /** An entry added before the table showed (a card's first, which makes its book): shown open. */
  added?: number | null
  /** The side panel's narrow column: compact headers, the toolbar folded tighter. */
  panel?: boolean
  /** Extra toolbar controls (the panel's search and replace toggle). */
  tools?: ReactNode
  /** The save cluster, leading the entries' toolbar row (DESIGN §10.1). */
  saveControls?: ReactNode
}) {
  // Both editors can render the same entry UID at once; focus must stay in this table.
  const idPrefix = useId()
  const columns = useRegistry(lorebookColumns)
  const sorts = useRegistry(lorebookSorts)
  const actions = useRegistry(lorebookEntryActions)
  const card = useEditorKind(store) === "card"
  const scope = `entries:${store.refId}:${root.join("/")}`
  const [query, changeQuery] = usePlaceParam(`${scope}:q`, "")
  const setQuery = (next: string) => changeQuery(next, true)
  const [enabled, changeEnabled] = usePlaceParam<EnabledFilter>(`${scope}:show`, "all", ["all", "on", "off"])
  const setEnabled = (next: EnabledFilter) => changeEnabled(next, true)
  const [sortId, changeSort] = usePlaceParam(
    `${scope}:sort`,
    "order",
    sorts.map((s) => s.id)
  )
  const setSortId = (next: string) => changeSort(next, true)
  // A URL target belongs to its view: restoring it must not open or focus the other editor.
  const entryScope = panel ? `${scope}:panel` : scope
  const [entryKey, setEntryKey] = usePlaceParam(`${entryScope}:entry`, "")
  const entry = entryKey === "" ? null : Number(entryKey)
  const enteredHere = useRef<number | null>(null)
  usePlaceNotice(
    entry !== null && !book.entries.some((e) => e.uid === entry) ? "This entry is no longer in the lorebook." : null
  )
  const [opened, setOpened] = useOpenEntries(store.refId, root, added, panel)
  // Opened entries whose settings are open too: closed again with the page.
  const [settings, setSettings] = useState<ReadonlySet<number>>(EMPTY)
  const showSettings = (uid: number, open: boolean) =>
    setSettings((set) => {
      const next = new Set(set)
      if (open) next.add(uid)
      else next.delete(uid)
      return next
    })
  // Entries just added or duplicated lead the table, newest first, until the search, filter
  // or sort changes: a second one doesn't push the first away to its sorted place.
  const [pinned, setPinned] = useState<ReadonlyArray<number>>(added === null ? [] : [added])
  const [focus, setFocus] = useState<{ uid: number; at: "title" | "keys" } | null>(
    added === null ? null : { uid: added, at: "title" }
  )
  const [dialog, setDialog] = useState<{ uid: number; action: ComponentType<LorebookActionProps> } | null>(null)
  // Selection mode, for "Change for selected…".
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [massEdit, setMassEdit] = useState(false)
  const sort = sorts.find((s) => s.id === sortId) ?? sorts[0]

  // The order is worked out when what decides it changes, not on every edit.
  const signature = book.entries.map((entry) => entry.uid).join(",")
  const orderKey = JSON.stringify([signature, query, enabled, sort?.id, pinned])
  const arrange = () => {
    const changed = changedUids(store, root)
    return arrangeEntries(book.entries, {
      query,
      enabled,
      sort,
      pinned,
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
  useEffect(() => {
    if (!match) return
    const frame = requestAnimationFrame(() => {
      const at = JSON.stringify(match.path.slice(0, root.length + 1)) === JSON.stringify([...root, "entries"])
      const uid = at ? uidOf(match.path[root.length + 1]) : null
      if (uid !== null) {
        enteredHere.current = uid
        setEntryKey(String(uid), true)
        setQuery("")
        setEnabled("all")
        setOpened((set) => new Set(set).add(uid))
        if (!SHOWN.has(String(match.path[root.length + 2]))) showSettings(uid, true)
        setFocus({ uid, at: "title" })
      }
    })
    return () => cancelAnimationFrame(frame)
    // Only a new search visit restores the match; edits and folds must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match])
  useEffect(() => {
    const local = enteredHere.current
    enteredHere.current = null
    if (entry === local || entry === null || !book.entries.some((e) => e.uid === entry)) return
    const frame = requestAnimationFrame(() => {
      setOpened((set) => new Set(set).add(entry))
      setFocus({ uid: entry, at: "title" })
    })
    return () => cancelAnimationFrame(frame)
    // Restore only a new URL target, not each edit or fold of that entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry])

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
  const wide = width === 0 ? !panel : width >= WIDE
  const compact = panel || !wide
  const template = `${selecting ? "6.25rem" : "4.5rem"} minmax(10rem,1fr) ${columns.map((column) => column.width).join(" ")} 4.25rem`

  const toggle = (uid: number, open: boolean, at?: "keys") => {
    enteredHere.current = open ? uid : null
    setEntryKey(open ? String(uid) : "", true)
    setOpened((set) => {
      const next = new Set(set)
      if (open) next.add(uid)
      else next.delete(uid)
      return next
    })
    if (at) setFocus({ uid, at })
  }
  const reveal = (uid: number) => {
    enteredHere.current = uid
    setEntryKey(String(uid), true)
    setQuery("")
    setEnabled("all")
    setPinned((list) => [uid, ...list.filter((other) => other !== uid)])
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
  const select = (uid: number, next: boolean) =>
    setSelected((set) => {
      const copy = new Set(set)
      if (next) copy.add(uid)
      else copy.delete(uid)
      return copy
    })
  /** Every entry's own switch at once: the book itself stays on (owner, 2026-11-01). */
  const switchAll = (on: boolean) => {
    const edits = enableAllEdits(store, root, on)
    const count = new Set(edits.map((edit) => String(edit.path.at(-2)))).size
    applyMassChange(
      store,
      `${on ? "Enabled" : "Disabled"} ${count === book.entries.length ? "all " : ""}${entriesLabel(count)}`,
      edits
    )
  }

  const savedUids = ((getAt(store.head, [...root, "entries"]) ?? []) as ReadonlyArray<LorebookEntry>).map(
    (entry) => entry.uid
  )
  const removed = savedUids.filter((uid) => !book.entries.some((entry) => entry.uid === uid))
  const dialogEntry = dialog ? (store.value(entryPath(root, dialog.uid)) as LorebookEntry | undefined) : undefined
  const filtered = query.trim() !== "" || enabled !== "all"
  const live = book.entries.filter((entry) => selected.has(entry.uid)).map((entry) => entry.uid)
  const small = panel ? "h-8! px-2!" : "h-8! px-2.5!"

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            className={panel ? small : ""}
            hint="A new entry at the top, open, with its title ready to type."
            onClick={() => {
              const uid = addEntry(store, root, book)
              reveal(uid)
            }}
          >
            <Icon name="insert" />
            Add entry
          </Button>
          {/* Wide enough for its placeholder: on a phone it takes its own line. */}
          <div className={`${panel ? "min-w-[11rem]" : "min-w-[16rem]"} max-w-controls flex-1`}>
            <Tooltip label="Shows only the entries whose title, keys or text have every word typed. Search and replace changes text.">
              <Input
                type="search"
                aria-label="Filter by titles, keys and content"
                placeholder={panel ? "Filter entries" : "Filter by titles, keys and content"}
                className={panel ? "h-8!" : ""}
                value={query}
                onChange={(event) => {
                  setPinned([])
                  setQuery(event.currentTarget.value)
                }}
              />
            </Tooltip>
          </div>
          {tools}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Show"
            value={enabled}
            onValueChange={(next) => {
              setPinned([])
              setEnabled(next)
            }}
            options={[
              { value: "all", label: "All", description: "Every entry." },
              { value: "on", label: "Enabled", description: "Only entries whose switch is on." },
              { value: "off", label: "Disabled", description: "Only entries whose switch is off." }
            ]}
          />
          <div className="flex items-center gap-2">
            <span className={panel ? "sr-only" : "text-sm text-muted"}>Sort by</span>
            <div className={panel ? "w-36" : "w-44"}>
              <Select
                ariaLabel="Sort entries by"
                items={sorts.map((s) => ({ value: s.id, label: s.label, description: s.description }))}
                value={sort?.id ?? null}
                onValueChange={(next) => {
                  setPinned([])
                  setSortId(next)
                }}
              />
            </div>
          </div>
          <span className="flex-1" />
          {/* A standalone book's header has its count; here it's how many the search leaves. */}
          {(filtered || card || panel) && (
            <p role="status" className="text-sm text-muted">
              {filtered
                ? `${uids.length.toLocaleString()} of ${entriesLabel(book.entries.length)}`
                : entriesLabel(book.entries.length)}
            </p>
          )}
        </div>
        <div
          role="toolbar"
          aria-label="All entries"
          className={`flex flex-wrap items-center ${panel ? "gap-0.5" : "gap-1.5"} ${saveControls ? "justify-end" : ""}`}
        >
          {/* The save cluster leads the row, the toolbar's buttons on the right (DESIGN §10.1). */}
          {saveControls && <div className="mr-auto flex">{saveControls}</div>}
          <Button
            variant="ghost"
            className={small}
            disabled={uids.length === 0}
            hint="Opens every entry shown, to read them one after another. Their settings stay folded."
            onClick={() => setOpened((set) => new Set([...set, ...uids]))}
          >
            Expand all
          </Button>
          <Button
            variant="ghost"
            className={small}
            disabled={opened.size === 0}
            hint="Closes every entry to its one-line header."
            onClick={() => {
              enteredHere.current = null
              setEntryKey("", true)
              setOpened(new Set())
            }}
          >
            Collapse all
          </Button>
          {!panel && <span aria-hidden="true" className="h-5 w-px bg-border" />}
          <Button
            variant="ghost"
            className={small}
            disabled={book.entries.length === 0 || book.entries.every((entry) => entry.enabled)}
            hint="Switches every entry on, the hidden ones too. An unsaved change like any edit: Save keeps it, Revert undoes it."
            onClick={() => switchAll(true)}
          >
            Enable all
          </Button>
          <Button
            variant="ghost"
            className={small}
            disabled={book.entries.length === 0 || book.entries.every((entry) => !entry.enabled)}
            hint="Switches every entry off, to turn a few back on. The book stays in the chat. An unsaved change like any edit: Save keeps it, Revert undoes it."
            onClick={() => switchAll(false)}
          >
            Disable all
          </Button>
          {!panel && <span aria-hidden="true" className="h-5 w-px bg-border" />}
          <Button
            variant="ghost"
            className={small}
            aria-pressed={selecting}
            disabled={book.entries.length === 0}
            hint={
              selecting
                ? "Stop selecting entries."
                : "Select several entries to change a setting on all of them at once."
            }
            onClick={() => {
              setSelecting(!selecting)
              setSelected(new Set())
            }}
          >
            <Icon name="check" />
            {selecting ? "Done selecting" : "Select"}
          </Button>
        </div>
        {selecting && (
          <div
            role="region"
            aria-label="Selected entries"
            className="flex flex-wrap items-center gap-1.5 rounded-md border border-accent/40 bg-accent/5 px-2 py-1.5 text-sm"
          >
            <span role="status" className="px-1 font-medium">
              {live.length.toLocaleString()} selected
            </span>
            <Button
              variant="ghost"
              className={small}
              hint="Every entry in the book, those the filter hides too."
              onClick={() => setSelected(new Set(book.entries.map((entry) => entry.uid)))}
            >
              All {book.entries.length.toLocaleString()}
            </Button>
            {filtered && (
              <Button
                variant="ghost"
                className={small}
                hint="The entries the filter and Show leave, adding them to the selection."
                onClick={() => setSelected((set) => new Set([...set, ...uids]))}
              >
                The {uids.length.toLocaleString()} shown
              </Button>
            )}
            <Button
              variant="ghost"
              className={small}
              disabled={live.length === 0}
              hint="Clears the selection."
              onClick={() => setSelected(new Set())}
            >
              None
            </Button>
            <span className="flex-1" />
            <Button
              variant="primary"
              className={small}
              disabled={live.length === 0}
              hint="Give every selected entry the same value for one setting; their other settings stay as they are."
              onClick={() => setMassEdit(true)}
            >
              Change for selected…
            </Button>
          </div>
        )}
        <Removed store={store} root={root} uids={removed} />
      </div>

      <div ref={list} className="min-w-0 rounded-lg border border-border bg-canvas">
        {!compact && uids.length > 0 && (
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
            row={{
              idPrefix,
              store,
              root,
              wide,
              compact,
              card,
              template,
              columns,
              actions,
              selecting,
              onSelect: select,
              onToggle: toggle,
              onSettings: showSettings,
              onAction: runAction
            }}
            opened={opened}
            settings={settings}
            selected={selecting ? selected : EMPTY}
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
      {massEdit && <MassEditDialog store={store} root={root} uids={live} onClose={() => setMassEdit(false)} />}
    </div>
  )
}

const EMPTY: ReadonlySet<number> = new Set()
