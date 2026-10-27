// The side panel's Lorebooks tab (DESIGN §1.3, §5.0): the lorebooks this chat reads, by kind:
// each member card's own, those added to this chat, and the user's global ones, each with its
// switch, and the "only below the history" setting. Every switch is a state event at the leaf
// shown, so from there on, on this branch; marking a book global is the user's, for every chat.
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import { useEffect, useId, useState } from "react"
import { useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
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

const open = `${buttonClass("ghost")} h-8 px-2`

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

/** The setting, with what it does and why, right where the books are chosen (DESIGN §1.3). */
function BelowHistory({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <section aria-label="Placement" className="flex items-start gap-2 rounded-md border border-border p-3">
      <div className="min-w-0 flex-1">
        <Switch
          checked={on}
          onCheckedChange={onChange}
          description={
            on
              ? "Every entry goes after the history, whatever its position, and is looked at again every turn."
              : "Entries go where their positions say. Entries placed above the history stay until the history's start next moves."
          }
        >
          Only below the history
        </Switch>
      </div>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="?"
        triggerLabel="Why only below the history"
        hint="Why?"
        triggerClassName={`${buttonClass("ghost")} h-8 w-8 px-0`}
        title="Only below the history"
        side="bottom"
        align="end"
      >
        <p className="text-sm">
          <strong>Why:</strong> the model's provider keeps what it has already read (its cache) only up to the first
          thing that changed. An entry that comes and goes above the history changes everything after it, so the whole
          history is read again, slowly and at full price.
        </p>
        <p className="text-sm">
          <strong>How:</strong> with this on, each entry's position is overridden: every activated entry goes in one
          block just after the history, at the start of the tail, and is looked at again every turn.
        </p>
        <p className="text-sm text-muted">
          Off, entries go where their positions say. Those above the history are kept until the history's start next
          moves, then looked at again; those after it are looked at every turn, as in SillyTavern.
        </p>
      </Popover>
    </section>
  )
}

function Row({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 py-3 first:pt-0">
      <div className="min-w-0 flex-1">{children}</div>
      {actions}
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
  const openLink = (id: string, name: string) => {
    const ref = byId.get(id)
    return (
      ref && (
        <Link to="/library/$refId" params={{ refId: ref.id }} className={open} aria-label={`Open ${name}`}>
          Open
        </Link>
      )
    )
  }
  return (
    <div className="flex flex-col gap-5">
      <BelowHistory
        on={cast?.loreBelowHistory ?? true}
        onChange={(on) => void change({ _tag: "LoreBelowHistory", on })}
      />
      <p className="text-sm text-muted">Changes apply from the latest message on, on this branch.</p>

      <section aria-labelledby="lore-own" className="flex flex-col gap-2">
        <h3 id="lore-own" className={heading}>
          Characters' books
        </h3>
        {own.length === 0 ? (
          <p className="text-sm text-muted">No character in this chat has a lorebook of its own.</p>
        ) : (
          <ul aria-label="Characters' books" className="flex flex-col divide-y divide-border">
            {own.map((card) => {
              const ref = library?.cards.get(card.entityId)
              const on = !cast?.cardLorebooksOff.includes(card.entityId)
              const from = [
                `${card.name}'s own lorebook`,
                ...(card.lorebookEntries === undefined ? [] : [entries(card.lorebookEntries)])
              ].join(" · ")
              return (
                <Row
                  key={card.entityId}
                  actions={
                    ref && (
                      <Link
                        to="/library/$refId"
                        params={{ refId: ref.id }}
                        className={open}
                        aria-label={`Open ${card.name}'s card`}
                      >
                        Open card
                      </Link>
                    )
                  }
                >
                  <Switch
                    checked={on}
                    onCheckedChange={(next) => void change({ _tag: "CardLorebook", entityId: card.entityId, on: next })}
                    description={
                      on
                        ? from
                        : `${from}. Off in this chat, so its entries aren't sent. An import from SillyTavern turns it off where ST hadn't imported the card's book either.`
                    }
                  >
                    {card.lorebookName ?? `${card.name}'s lorebook`}
                  </Switch>
                </Row>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="lore-added" className="flex flex-col gap-2">
        <h3 id="lore-added" className={heading}>
          Added to this chat
        </h3>
        {sections.added.length === 0 ? (
          <p className="text-sm text-muted">None yet.</p>
        ) : (
          <ul aria-label="Added to this chat" className="flex flex-col divide-y divide-border">
            {sections.added.map(({ id, on, global: isGlobal }) => {
              const name = nameOf(id)
              return (
                <Row
                  key={id}
                  actions={
                    <>
                      {openLink(id, name)}
                      {byId.has(id) && !isGlobal && (
                        <Button
                          variant="ghost"
                          className="h-8 px-2"
                          aria-label={`Use ${name} in every chat`}
                          onClick={() => void setGlobal(id as LibraryRef["id"], true)}
                        >
                          Use in every chat
                        </Button>
                      )}
                    </>
                  }
                >
                  <Switch
                    checked={on}
                    onCheckedChange={(next) => {
                      setDetached((list) => (next ? list.filter((d) => d !== id) : [...list, id]))
                      void change({ _tag: "Lorebook", ref: id as LibraryRef["id"], active: next })
                    }}
                    description={[
                      on ? "Added to this chat" : "Taken off this chat",
                      ...(isGlobal ? ["also used in every chat"] : []),
                      ...(byId.get(id)?.subtitle ? [byId.get(id)!.subtitle] : [])
                    ].join(" · ")}
                  >
                    {name}
                  </Switch>
                </Row>
              )
            })}
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
          <div>
            <Button onClick={() => setAdding(true)} disabled={library === null}>
              Add lorebook
            </Button>
          </div>
        )}
      </section>

      <section aria-labelledby="lore-global" className="flex flex-col gap-2">
        <h3 id="lore-global" className={heading}>
          Global
        </h3>
        {sections.global.length === 0 ? (
          <p className="text-sm text-muted">
            No global lorebook. A book marked “Use in every chat”, here or in the library, is listed here.
          </p>
        ) : (
          <ul aria-label="Global lorebooks" className="flex flex-col divide-y divide-border">
            {sections.global.map(({ id, on }) => {
              const name = nameOf(id)
              return (
                <Row
                  key={id}
                  actions={
                    <>
                      {openLink(id, name)}
                      <Button
                        variant="ghost"
                        className="h-8 px-2"
                        aria-label={`Stop using ${name} in every chat`}
                        onClick={() => void setGlobal(id as LibraryRef["id"], false)}
                      >
                        Not global
                      </Button>
                    </>
                  }
                >
                  <Switch
                    checked={on}
                    onCheckedChange={(next) =>
                      void change({ _tag: "GlobalLorebook", ref: id as LibraryRef["id"], on: next })
                    }
                    description={on ? "Used in every chat" : "Used in every chat, but off in this one"}
                  >
                    {name}
                  </Switch>
                </Row>
              )
            })}
          </ul>
        )}
      </section>
      {(error ?? action.error) && (
        <p role="alert" className="text-sm text-danger">
          {(error ?? action.error)!.message}
        </p>
      )}
    </div>
  )
}
