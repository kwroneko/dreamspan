// The side panel's Lorebooks tab (DESIGN §4): only the lorebooks that apply to this chat:
// those attached to it, and each member card's own, which the chat can turn off. Attaching,
// detaching and turning off are state events at the leaf shown, so from there on, on this branch.
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import { useEffect, useId, useState } from "react"
import { useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Input } from "../../ui/Field.tsx"
import { useCast } from "./cast.ts"
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

export function LorebooksTab({ session }: { session: ChatSession }) {
  const { cast, cards } = useCast()
  const action = useAction()
  const [error, setError] = useState<AppError | null>(null)
  const [library, setLibrary] = useState<Library | null>(null)
  const [adding, setAdding] = useState(false)
  const change = async (next: CastChange) => {
    const outcome = await session.changeCast(next)
    setError(outcome.ok ? null : outcome.error)
  }
  useEffect(() => {
    void action
      .run((client) =>
        Effect.all({
          lorebooks: client("ListLibrary", { kind: "lorebook" }),
          cards: client("ListLibrary", { kind: "card" })
        })
      )
      .then(
        (result) =>
          result.ok &&
          setLibrary({
            lorebooks: result.value.lorebooks,
            // The card's upstream ref, where its own lorebook is edited.
            cards: new Map(
              result.value.cards.filter((ref) => ref.refKind === "upstream").map((ref) => [ref.entityId as string, ref])
            )
          })
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [])
  const attached = cast?.lorebooks ?? []
  const own = (cast?.participants ?? []).flatMap((id) => {
    const card = cards.get(id)
    return card?.lorebook && !card.inBin ? [card] : []
  })
  const byId = new Map((library?.lorebooks ?? []).map((ref) => [ref.id as string, ref]))
  const addable = (library?.lorebooks ?? []).filter((ref) => !attached.includes(ref.id))
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        The lorebooks this chat reads entries from. Changes apply from the latest message on, on this branch.
      </p>
      {attached.length === 0 && own.length === 0 ? (
        <p className="text-sm text-muted">No lorebook applies to this chat.</p>
      ) : (
        <ul aria-label="Lorebooks in this chat" className="flex flex-col divide-y divide-border">
          {attached.map((id) => {
            const ref = byId.get(id)
            const name = ref?.label ?? (library === null ? "…" : "A lorebook no longer in the library")
            return (
              <li key={id} className="flex items-start gap-2 py-3 first:pt-0">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium [overflow-wrap:anywhere]">{name}</span>
                  <span className="text-sm text-muted">
                    Attached to this chat{ref?.subtitle ? ` · ${ref.subtitle}` : ""}
                  </span>
                </div>
                {ref && (
                  <Link to="/library/$refId" params={{ refId: ref.id }} className={open} aria-label={`Open ${name}`}>
                    Open
                  </Link>
                )}
                <Button
                  variant="ghost"
                  className="h-8 px-2"
                  aria-label={`Detach ${name}`}
                  onClick={() => void change({ _tag: "Lorebook", ref: id, active: false })}
                >
                  Detach
                </Button>
              </li>
            )
          })}
          {own.map((card) => {
            const ref = library?.cards.get(card.entityId)
            const on = !cast?.cardLorebooksOff.includes(card.entityId)
            return (
              <li key={card.entityId} className="flex items-start gap-2 py-3 first:pt-0">
                <div className="min-w-0 flex-1">
                  <Switch
                    checked={on}
                    onCheckedChange={(next) => void change({ _tag: "CardLorebook", entityId: card.entityId, on: next })}
                    description={
                      on
                        ? `Part of ${card.name}'s card.`
                        : `Part of ${card.name}'s card. Off in this chat, so its entries aren't sent. An import from SillyTavern turns it off where ST hadn't imported the card's book either.`
                    }
                  >
                    {card.name}'s lorebook
                  </Switch>
                </div>
                {ref && (
                  <Link
                    to="/library/$refId"
                    params={{ refId: ref.id }}
                    className={open}
                    aria-label={`Open ${card.name}'s card`}
                  >
                    Open card
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {adding ? (
        <Picker
          lorebooks={addable}
          onAttach={(ref) => {
            setAdding(false)
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
      {(error ?? action.error) && (
        <p role="alert" className="text-sm text-danger">
          {(error ?? action.error)!.message}
        </p>
      )}
    </div>
  )
}
