// The lorebook table's default columns, sort orders and row actions (lorebookTable.ts), as
// SillyTavern's World Info editor has them: strategy, position, depth, order and trigger %
// inline, and duplicate, copy or move to another book, and delete in a row's menu.
import type { LorebookDoc, LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import { type FieldPath, valueField } from "@rp/shared/editing.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Input } from "../../ui/Field.tsx"
import { NativeSelect } from "../../ui/Select.tsx"
import { useSession } from "../../session.ts"
import { useCaller } from "./caller.ts"
import {
  entryPath,
  freshUid,
  type LorebookActionProps,
  lorebookColumns,
  type LorebookEntryContext,
  lorebookEntryActions,
  lorebookSorts,
  POSITIONS,
  positionValue,
  type Strategy,
  strategyOf
} from "./lorebookTable.ts"
import { EditorStore, useDirty, useValue } from "./store.ts"

const edited = (dirty: boolean) => (dirty ? "border-accent ring-1 ring-accent/40" : "")

/** A number in a cell, kept as typed until it's a number; the field's draft as NumberField's. */
function NumberCell({
  store,
  path,
  label,
  min,
  max,
  disabled = false
}: {
  store: EditorStore
  path: FieldPath
  label: string
  min?: number
  max?: number
  disabled?: boolean
}) {
  const value = useValue<number | null>(store, path)
  const [typed, setTyped] = useState<string | null>(null)
  const field = valueField(path)
  const dirty = useDirty(store, field)
  const accept = (text: string) => {
    setTyped(text)
    const number = Number(text)
    const valid =
      text.trim() !== "" &&
      Number.isInteger(number) &&
      (min === undefined || number >= min) &&
      (max === undefined || number <= max)
    if (valid && number !== value) store.setValue(path, number)
  }
  return (
    <Input
      aria-label={label}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      disabled={disabled}
      className={`h-8! px-2! tabular-nums ${edited(dirty)}`}
      value={disabled ? "" : (typed ?? (typeof value === "number" ? String(value) : ""))}
      placeholder={disabled ? "–" : undefined}
      onChange={(event) => accept(event.currentTarget.value)}
      onBlur={() => {
        setTyped(null)
        void store.save(field)
      }}
    />
  )
}

const STRATEGIES: ReadonlyArray<{ readonly value: Strategy; readonly label: string; readonly description: string }> = [
  { value: "constant", label: "Constant", description: "Included without a key match, while it's enabled." },
  { value: "normal", label: "Normal", description: "Included when one of its primary keys appears in the chat." },
  {
    value: "vectorized",
    label: "Vectorized",
    description: "Meant to match by similarity to the chat. Not yet: for now it matches its keys."
  }
]

function StrategyCell({ store, path, entry, title }: LorebookEntryContext) {
  const constant = useDirty(store, valueField([...path, "constant"]))
  const vectorized = useDirty(store, valueField([...path, "vectorized"]))
  const dirty = constant || vectorized
  return (
    <NativeSelect
      ariaLabel={`Strategy of ${title}`}
      className={`h-8! ${edited(dirty)}`}
      items={STRATEGIES}
      value={strategyOf(entry)}
      onValueChange={(next) => {
        if ((next === "constant") !== entry.constant) store.setValue([...path, "constant"], next === "constant")
        if ((next === "vectorized") !== entry.vectorized) store.setValue([...path, "vectorized"], next === "vectorized")
      }}
    />
  )
}

function PositionCell({ store, path, entry, title }: LorebookEntryContext) {
  const position = useDirty(store, valueField([...path, "position"]))
  const role = useDirty(store, valueField([...path, "role"]))
  const dirty = position || role
  return (
    <NativeSelect
      ariaLabel={`Position of ${title}`}
      className={`h-8! ${edited(dirty)}`}
      items={POSITIONS}
      value={positionValue(entry)}
      shown={(value) => POSITIONS.find((item) => item.value === value)?.short ?? value}
      onValueChange={(next) => {
        const picked = POSITIONS.find((item) => item.value === next)!
        if (picked.position !== entry.position) store.setValue([...path, "position"], picked.position)
        if (picked.role && picked.role !== entry.role) store.setValue([...path, "role"], picked.role)
      }}
    />
  )
}

const DepthCell = ({ store, path, entry, title }: LorebookEntryContext) => (
  <NumberCell
    store={store}
    path={[...path, "depth"]}
    label={`Depth of ${title}`}
    min={0}
    disabled={entry.position !== "at_depth"}
  />
)
const OrderCell = ({ store, path, title }: LorebookEntryContext) => (
  <NumberCell store={store} path={[...path, "order"]} label={`Order of ${title}`} />
)
const TriggerCell = ({ store, path, title }: LorebookEntryContext) => (
  <NumberCell store={store} path={[...path, "probability"]} label={`Trigger % of ${title}`} min={0} max={100} />
)

/** The entry as typed: its title and content drafts applied. */
const workingEntry = (store: EditorStore, path: FieldPath, entry: LorebookEntry): LorebookEntry => ({
  ...entry,
  comment: store.text([...path, "comment"]),
  content: store.text([...path, "content"])
})

/**
 * Puts a copy of the entry in another lorebook and saves it there as a revision of that book,
 * leaving that book's own drafts alone.
 */
async function copyInto(
  target: EditorStore,
  entry: LorebookEntry,
  from: string
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: AppError }> {
  await target.load()
  if (target.loadError) return { ok: false, error: target.loadError }
  const uid = freshUid(target.value([]) as LorebookDoc)
  target.setValue(entryPath([], uid), { ...entry, uid })
  const title = entry.comment || "Untitled entry"
  const result = await target.commit(`Copied “${title}” from ${from}`, [valueField(entryPath([], uid))])
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

/** Copy or move an entry to another of the library's lorebooks. */
function ToAnotherBook({ store, path, entry, title, onClose, move }: LorebookActionProps & { move: boolean }) {
  const call = useCaller()
  const userId = useSession().user.id
  const [books, setBooks] = useState<ReadonlyArray<LibraryRef> | null>(null)
  const [query, setQuery] = useState("")
  const [target, setTarget] = useState<LibraryRef | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    void call((client) => client("ListLibrary", { kind: "lorebook" })).then((result) =>
      result.ok ? setBooks(result.value.filter((ref) => ref.id !== store.refId)) : setError(result.error)
    )
  }, [call, store.refId])
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = (books ?? []).filter((ref) => words.every((word) => ref.label.toLowerCase().includes(word)))
  const from = store.snapshot?.ref.label ?? "another lorebook"
  const go = async () => {
    if (!target) return
    setPending(true)
    const result = await copyInto(new EditorStore(target.id, userId, call), workingEntry(store, path, entry), from)
    setPending(false)
    if (!result.ok) return setError(result.error)
    if (move) await store.removeItem(path)
    onClose()
  }
  const verb = move ? "Move" : "Copy"
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`${verb} “${title}” to another lorebook`}
      description={
        move
          ? "It's saved in the lorebook you choose right away. Here it's removed as a change, saved with this book's other changes."
          : "It's saved in the lorebook you choose right away. This book keeps it."
      }
    >
      <ErrorAlert error={error} />
      <Input
        type="search"
        aria-label="Find a lorebook"
        placeholder="Find a lorebook"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        autoFocus
      />
      {books === null ? (
        error === null && <p className="text-sm text-muted">Loading the library's lorebooks…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted">
          {books.length === 0 ? "There's no other lorebook." : "No lorebook matches."}
        </p>
      ) : (
        <ul aria-label="Lorebooks" className="flex max-h-72 flex-col overflow-y-auto">
          {shown.map((ref) => (
            <li key={ref.id}>
              <button
                type="button"
                aria-pressed={target?.id === ref.id}
                onClick={() => setTarget(ref)}
                className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus aria-pressed:bg-surface-raised aria-pressed:font-medium aria-pressed:ring-1 aria-pressed:ring-accent"
              >
                {ref.label}
                {ref.subtitle && <span className="text-xs text-muted">{ref.subtitle}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <DialogActions>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={target === null} pending={pending} onClick={() => void go()}>
          {target ? `${verb} to ${target.label}` : verb}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

const CopyToBook = (props: LorebookActionProps) => <ToAnotherBook {...props} move={false} />
const MoveToBook = (props: LorebookActionProps) => <ToAnotherBook {...props} move />

const number = (a: number, b: number) => a - b

export const registerLorebookTable = () => {
  lorebookColumns.register({ id: "strategy", order: 10, header: "Strategy", width: "7rem", cell: StrategyCell })
  lorebookColumns.register({ id: "position", order: 20, header: "Position", width: "7.5rem", cell: PositionCell })
  lorebookColumns.register({ id: "depth", order: 30, header: "Depth", width: "4.25rem", cell: DepthCell })
  lorebookColumns.register({ id: "order", order: 40, header: "Order", width: "4.75rem", cell: OrderCell })
  lorebookColumns.register({ id: "trigger", order: 50, header: "Trigger %", width: "4.75rem", cell: TriggerCell })

  // ST's "Priority": the highest order first.
  lorebookSorts.register({
    id: "order",
    order: 10,
    label: "Order",
    description: "Highest order first.",
    compare: (a, b) => number(b.order, a.order)
  })
  lorebookSorts.register({
    id: "title",
    order: 20,
    label: "Title",
    compare: (a, b, facts) => facts(a).title.localeCompare(facts(b).title, undefined, { numeric: true })
  })
  lorebookSorts.register({
    id: "depth",
    order: 30,
    label: "Depth",
    description: "Lowest depth first.",
    compare: (a, b) => number(a.depth, b.depth)
  })
  lorebookSorts.register({
    id: "trigger",
    order: 40,
    label: "Trigger %",
    description: "Highest chance first.",
    compare: (a, b) => number(b.probability, a.probability)
  })
  // Entries keep no time of change: the ones with unsaved changes come first, then the newest added.
  lorebookSorts.register({
    id: "changed",
    order: 50,
    label: "Recently changed",
    description: "Entries with unsaved changes first, then the newest added.",
    compare: (a, b, facts) => Number(facts(b).changed) - Number(facts(a).changed) || facts(b).index - facts(a).index
  })

  lorebookEntryActions.register({
    id: "duplicate",
    order: 10,
    label: "Duplicate",
    description: "A copy in this book, kept with its other unsaved changes.",
    icon: "duplicate",
    run: ({ store, path, entry, book, root, reveal }) => {
      const uid = freshUid(book)
      const copy = workingEntry(store, path, entry)
      store.setValue(entryPath(root, uid), { ...copy, uid, comment: `${copy.comment || "Untitled entry"} (copy)` })
      reveal(uid)
    }
  })
  lorebookEntryActions.register({
    id: "copy",
    order: 20,
    label: "Copy to another lorebook…",
    description: "Saves a copy in the lorebook you pick, right away. This book keeps it.",
    icon: "copy",
    dialog: CopyToBook
  })
  lorebookEntryActions.register({
    id: "move",
    order: 30,
    label: "Move to another lorebook…",
    description:
      "Saves it in the lorebook you pick right away. Its removal here is saved with this book's other changes.",
    icon: "right",
    dialog: MoveToBook
  })
  lorebookEntryActions.register({
    id: "delete",
    order: 100,
    label: "Delete",
    description:
      "Out of the book at once: replies stop using it. Until you save, Restore above the entries brings it back.",
    icon: "trash",
    tone: "danger",
    run: ({ store, path }) => void store.removeItem(path)
  })
}
