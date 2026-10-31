// The side panel's Lorebooks tab (DESIGN §1.3, §5.0): the books this chat reads, first (each
// member card's own, those added to this chat, the user's global ones), each with its switch,
// Open (its editor over the chat) and ⋯; then where entries go.
// Every switch is a state event at the leaf shown, so from there on, on this branch; marking a
// book global is the user's, for every chat.
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { Effect } from "effect"
import { useEffect, useId, useState } from "react"
import { useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { ActionMenu, type ActionMenuItem } from "../../ui/Menu.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Input } from "../../ui/Field.tsx"
import { useCast } from "./cast.ts"
import { lorebookSections } from "./lorebookSections.ts"
import type { ChatSession } from "./session.ts"

interface Library {
  readonly lorebooks: ReadonlyArray<LibraryRef>
  /** Cards' refs by entity, to open a card's own lorebook in the editor. */
  readonly cards: ReadonlyMap<string, LibraryRef>
}

/** The library's lorebooks not attached yet, filtered as typed. */
function Picker({
  lorebooks,
  onAttach,
  onClose
}: {
  lorebooks: ReadonlyArray<LibraryRef>
  onAttach: (ref: LibraryRef) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const id = useId()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = lorebooks.filter((ref) =>
    words.every((word) => `${ref.label} ${ref.subtitle}`.toLowerCase().includes(word))
  )
  return (
    <section aria-label="Add a lorebook" className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          Add a lorebook
        </label>
        <span className="flex-1" />
        <Button variant="ghost" className="h-8 px-2" onClick={onClose}>
          Close
        </Button>
      </div>
      <Input
        id={id}
        type="search"
        placeholder="Search the library's lorebooks"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        autoFocus
      />
      {lorebooks.length === 0 ? (
        <p className="text-sm text-muted">
          Every lorebook in the library is attached already, or there are none:{" "}
          <Link to="/library" className="text-accent hover:underline">
            import one in the library
          </Link>
          .
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted">No lorebook matches “{query}”.</p>
      ) : (
        <ul aria-label="Lorebooks to add" className="flex max-h-72 flex-col overflow-y-auto">
          {shown.map((ref) => (
            <li key={ref.id}>
              <button
                type="button"
                className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                onClick={() => onAttach(ref)}
              >
                <span className="font-medium">{ref.label}</span>
                {ref.subtitle && <span className="text-xs text-muted">{ref.subtitle}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const entries = (count: number) => `${count.toLocaleString()} ${count === 1 ? "entry" : "entries"}`

const heading = "text-xs font-medium tracking-wide text-muted uppercase"

/**
 * Where this chat's entries go (DESIGN §1.3): below the history, or where each entry's position
 * says. One setting for every book in the chat, so it follows the books, in plain words.
 */
function Placement({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <section aria-labelledby="lore-placement" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 id="lore-placement" className={heading}>
          Where entries go
        </h3>
        <Popover
          open={open}
          onOpenChange={setOpen}
          trigger="?"
          triggerLabel="Why below the history"
          hint="Why?"
          triggerClassName={`${buttonClass("ghost")} h-7 w-7 px-0`}
          title="Below the history"
          side="bottom"
          align="end"
        >
          <p className="text-sm">
            The model's provider keeps what it has already read (its cache) only up to the first thing that changed. An
            entry that comes and goes above the history changes everything after it, so the whole history is read again,
            slowly and at full price.
          </p>
          <p className="text-sm">
            Below the history, every entry that matches goes in one block just after the history, and is looked at again
            every turn. Where each entry says, as in SillyTavern, entries above the history stay until the history's
            start next moves.
          </p>
        </Popover>
      </div>
      <Segmented
        label="Where entries go"
        wrap
        value={on ? "below" : "positions"}
        onValueChange={(next) => onChange(next === "below")}
        options={[
          { value: "below", label: "Below the history" },
          { value: "positions", label: "Where each entry says" }
        ]}
      />
      <p className="text-sm text-muted">For every book in this chat.</p>
    </section>
  )
}

interface BookRow {
  readonly key: string
  readonly name: string
  /** Where it comes from: a character's, added to this chat, global. */
  readonly from: string
  readonly on: boolean
  readonly onChange: (on: boolean) => void
  /** The library entry its Open button edits: the book, or the card holding it. */
  readonly ref: LibraryRef | undefined
  readonly openLabel: string
  readonly menu: ReadonlyArray<ActionMenuItem>
}

/** A book: its switch in this chat, Open (its editor over the chat) and its ⋯. */
function Book({ row, onOpen }: { row: BookRow; onOpen: (ref: LibraryRef) => void }) {
  return (
    <li className="flex items-start gap-1 py-2.5">
      <div className="min-w-0 flex-1">
        <Switch checked={row.on} onCheckedChange={row.onChange} description={row.from}>
          {row.name}
        </Switch>
      </div>
      {row.ref && (
        <Button
          variant="ghost"
          className="h-8 shrink-0 px-2"
          aria-label={row.openLabel}
          onClick={() => onOpen(row.ref!)}
        >
          Open
        </Button>
      )}
      {row.menu.length > 0 && (
        <ActionMenu label={`More for ${row.name}`} trigger={<Icon name="more" />} items={row.menu} />
      )}
    </li>
  )
}

export function LorebooksTab({ session, active }: { session: ChatSession; active: boolean }) {
  const { cast, cards } = useCast()
  const action = useAction()
  const [error, setError] = useState<AppError | null>(null)
  const [library, setLibrary] = useState<Library | null>(null)
  const [globals, setGlobals] = useState<ReadonlyArray<string> | null>(null)
  const [adding, setAdding] = useState(false)
  // Books detached while the tab is open stay listed, off, so the switch can bring them back.
  const [detached, setDetached] = useState<ReadonlyArray<string>>([])
  const change = async (next: CastChange) => {
    const outcome = await session.changeCast(next)
    setError(outcome.ok ? null : outcome.error)
  }
  const setGlobal = async (ref: LibraryRef["id"], global: boolean) => {
    const outcome = await action.run((client) => client("SetGlobalLorebook", { ref, global }))
    if (outcome.ok) setGlobals(outcome.value)
  }
  // The library and the global books, read again each time the tab is shown.
  useEffect(() => {
    if (!active) return
    void action
      .run((client) =>
        Effect.all({
          lorebooks: client("ListLibrary", { kind: "lorebook" }),
          cards: client("ListLibrary", { kind: "card" }),
          globals: client("GetGlobalLorebooks", undefined)
        })
      )
      .then((result) => {
        if (!result.ok) return
        setGlobals(result.value.globals)
        setLibrary({
          lorebooks: result.value.lorebooks,
          // The card's upstream ref, where its own lorebook is edited.
          cards: new Map(
            result.value.cards.filter((ref) => ref.refKind === "upstream").map((ref) => [ref.entityId as string, ref])
          )
        })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each time it's shown
  }, [active])
  const attached = cast?.lorebooks ?? []
  const sections = lorebookSections({
    attached,
    detached,
    globals,
    globalsOff: cast?.globalLorebooksOff ?? []
  })
  const own = (cast?.participants ?? []).flatMap((id) => {
    const card = cards.get(id)
    return card?.lorebook && !card.inBin ? [card] : []
  })
  const byId = new Map((library?.lorebooks ?? []).map((ref) => [ref.id as string, ref]))
  const addable = (library?.lorebooks ?? []).filter((ref) => !attached.includes(ref.id))
  const nameOf = (id: string) => byId.get(id)?.label ?? (library === null ? "…" : "A lorebook no longer in the library")
  const navigate = useNavigate()
  const workspace = usePresetWorkspace()
  // Over the chat, as the preset and card editors open from the panel; a page without one.
  const openEditor = (ref: LibraryRef) =>
    workspace ? workspace.open(ref.id) : void navigate({ to: "/library/$refId", params: { refId: ref.id } })
  const detach = (id: string, next: boolean) => {
    setDetached((list) => (next ? list.filter((d) => d !== id) : [...list, id]))
    void change({ _tag: "Lorebook", ref: id as LibraryRef["id"], active: next })
  }
  const globalItem = (id: string, global: boolean): ActionMenuItem => ({
    label: "Use in every chat",
    checked: global,
    onCheckedChange: (next) => void setGlobal(id as LibraryRef["id"], next)
  })
  const rows: ReadonlyArray<BookRow> = [
    ...own.map((card): BookRow => {
      const on = !cast?.cardLorebooksOff.includes(card.entityId)
      return {
        key: `card:${card.entityId}`,
        name: card.lorebookName ?? `${card.name}'s lorebook`,
        from: [
          on ? `${card.name}'s own lorebook` : `${card.name}'s own lorebook, off in this chat`,
          ...(card.lorebookEntries === undefined ? [] : [entries(card.lorebookEntries)])
        ].join(" · "),
        on,
        onChange: (next) => void change({ _tag: "CardLorebook", entityId: card.entityId, on: next }),
        ref: library?.cards.get(card.entityId),
        openLabel: `Open ${card.name}'s card, where its book is edited`,
        menu: []
      }
    }),
    ...sections.added.map(({ id, on }): BookRow => {
      const name = nameOf(id)
      return {
        key: `added:${id}`,
        name,
        from: [
          on ? "Added to this chat" : "Taken off this chat",
          ...(byId.get(id)?.subtitle ? [byId.get(id)!.subtitle] : [])
        ].join(" · "),
        on,
        onChange: (next) => detach(id, next),
        ref: byId.get(id),
        openLabel: `Open ${name}`,
        menu: byId.has(id) ? [globalItem(id, false)] : []
      }
    }),
    ...sections.global.map(({ id, on, attached: alsoAdded }): BookRow => {
      const name = nameOf(id)
      return {
        key: `global:${id}`,
        name,
        from: on ? "Global: used in every chat" : "Global, but off in this chat",
        on,
        onChange: (next) => void change({ _tag: "GlobalLorebook", ref: id as LibraryRef["id"], on: next }),
        ref: byId.get(id),
        openLabel: `Open ${name}`,
        menu: [
          globalItem(id, true),
          // A separate attachment from before it was global: either use sends its entries.
          ...(alsoAdded
            ? [
                {
                  label: "Also added to this chat",
                  checked: attached.includes(id as LibraryRef["id"]),
                  onCheckedChange: (next: boolean) => detach(id, next)
                }
              ]
            : [])
        ]
      }
    })
  ]
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="lore-in-chat" className="flex flex-col gap-1">
        <h3 id="lore-in-chat" className={heading}>
          Lorebooks in this chat
        </h3>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">
            {cast === null || library === null ? "Loading…" : "No lorebook is in this chat. Add one below."}
          </p>
        ) : (
          <ul aria-label="Lorebooks in this chat" className="flex flex-col divide-y divide-border">
            {rows.map((row) => (
              <Book key={row.key} row={row} onOpen={openEditor} />
            ))}
          </ul>
        )}
        {adding ? (
          <Picker
            lorebooks={addable}
            onAttach={(ref) => {
              setAdding(false)
              setDetached((list) => list.filter((d) => d !== ref.id))
              void change({ _tag: "Lorebook", ref: ref.id, active: true })
            }}
            onClose={() => setAdding(false)}
          />
        ) : (
          <div className="pt-1">
            <Button onClick={() => setAdding(true)} disabled={library === null}>
              Add a lorebook
            </Button>
          </div>
        )}
      </section>

      <Placement on={cast?.loreBelowHistory ?? true} onChange={(on) => void change({ _tag: "LoreBelowHistory", on })} />
      <p className="text-sm text-muted">Switches apply from the latest message on, on this branch.</p>
      {(error ?? action.error) && (
        <p role="alert" className="text-sm text-danger">
          {(error ?? action.error)!.message}
        </p>
      )}
    </div>
  )
}
