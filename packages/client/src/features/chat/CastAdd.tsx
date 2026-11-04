// The Cast tab's Add characters section (owner, 2026-11-01; ST's group "Add Members" list):
// under the cast, collapsed until opened (remembered per account in this browser), the same
// character grid as the left panel's Characters, with its filter (with Include personas),
// sort and direction and the search. Tiles open the full editor; their separate Add control
// joins the character at the viewed leaf. Existing members keep a disabled In chat control.
// It's the `cast.add-characters` entry of `castSections`, so a plugin can replace or remove it.
import type { EntityId } from "@rp/shared/chat.ts"
import type { Cast } from "@rp/shared/chatSetupApi.ts"
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { AsyncView } from "../../actions.tsx"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { browseCards, mixesPersonas, useCardBrowse } from "../characters/cardBrowse.tsx"
import { CardBrowseBar } from "../characters/CardBrowseBar.tsx"
import {
  browsable,
  CharacterGrid,
  type ShellLibrary,
  shellAtom,
  type TilePick,
  type TileState
} from "../characters/shellData.tsx"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { readCastAddOpen, subscribeCastAdd, takeCastAddRequest, writeCastAddOpen } from "./castAddState.ts"
import type { PendingChat } from "./pendingChat.ts"
import type { ChatSession, Outcome } from "./session.ts"

/**
 * Who the grid adds to: a saved chat (a `Join` at the leaf shown), or a chat not made yet
 * (pendingChat.ts), where the character joins before the first send and greets after the others.
 */
interface CastAddTarget {
  readonly subscribe: (listener: () => void) => () => void
  readonly cast: () => Cast | null
  readonly join: (id: EntityId) => Promise<Outcome<unknown>>
  /** What a tile's tooltip says it does, and what's said once it's done. */
  readonly addHint: (name: string) => string
  readonly joined: (name: string) => string
}

const sessionTarget = (session: ChatSession): CastAddTarget => ({
  subscribe: session.subscribe,
  cast: () => session.snapshot().cast,
  join: (id) => session.changeCast({ _tag: "Join", entityId: id }),
  addHint: (name) => `Add ${name} to the chat`,
  joined: (name) => `${name} joined the chat.`
})

const pendingTarget = (pending: PendingChat): CastAddTarget => ({
  subscribe: pending.subscribe,
  cast: () => pending.view().cast,
  join: (id) => pending.join(id),
  addHint: (name) => `Add ${name}: they greet after the others, and the chat starts with them`,
  joined: (name) => `${name} joined the chat.`
})

type ShellCard = ShellLibrary["cards"][number]

/** What happened to the last add: below the grid, without moving its controls. */
type Said = { readonly tone: "done" | "failed"; readonly text: string }

/**
 * Where a card stands: being added, played by the user, in the chat, or (undefined) addable.
 * A tile is given this word, not functions of the cast, so an add re-renders only its tile.
 */
type Status = "adding" | "you" | "in"

const stateOf = (status: string | undefined): TileState => ({
  pending: status === "adding",
  done: status === "you" || status === "in"
})
const hintOf = (target: CastAddTarget, name: string, status: string | undefined) =>
  status === "you"
    ? `You play ${name} in this chat: they're your persona`
    : status === "in"
      ? `${name} is already in this chat`
      : status === "adding"
        ? `Adding ${name}…`
        : target.addHint(name)
/** `name` with its version, when it has one. */
const labelOf = (name: string, status: string | undefined) =>
  status === "you"
    ? `${name}: you play them here`
    : status === "in"
      ? `${name}: in this chat`
      : `Add ${name} to this chat`
const fullName = (c: ShellCard) => `${c.card.label}${c.card.subtitle ? ` · ${c.card.subtitle}` : ""}`
/** Tiles shown at first, and added by each Show more: hundreds of tiles at once are slow to make. */
const PAGE = 60

function AddGrid({
  target,
  data,
  focusSearch
}: {
  target: CastAddTarget
  data: ShellLibrary
  /** Moves the focus to the search when it changes (an outside request to add). */
  focusSearch: number
}) {
  const workspace = usePresetWorkspace()
  const cast = useSyncExternalStore(target.subscribe, target.cast)
  const [search, setSearch] = useState("")
  // Its own filter and sort, apart from the left panel's (cardBrowse.tsx).
  const [browse, setBrowse] = useCardBrowse("cast")
  // The adds under way, in the order clicked: each waits for the one before (one write at a time).
  const [adding, setAdding] = useState<ReadonlyArray<EntityId>>([])
  const queue = useRef<Promise<void>>(Promise.resolve())
  const [said, setSaid] = useState<Said | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusSearch === 0) return
    const search = searchRef.current
    search?.focus()
    // The popover that asked (the speaker switcher) hands the focus back to its trigger as it
    // finishes closing: take it again then, unless the person has moved into the section.
    const later = setTimeout(() => {
      if (!search?.closest("section")?.contains(document.activeElement)) search?.focus()
    }, 300)
    return () => clearTimeout(later)
  }, [focusSearch])

  const participants = cast?.participants ?? []
  const playedByMe = cast?.playedByMe ?? []
  const add = (id: EntityId, name: string) => {
    setAdding((now) => [...now, id])
    queue.current = queue.current.then(async () => {
      const outcome = await target.join(id)
      setAdding((now) => now.filter((e) => e !== id))
      setSaid(
        outcome.ok
          ? { tone: "done", text: target.joined(name) }
          : { tone: "failed", text: `${name} couldn't be added: ${outcome.error.message}` }
      )
    })
  }
  const status = new Map<string, Status>([
    ...participants.map((id) => [id, "in"] as const),
    ...playedByMe.map((id) => [id, "you"] as const),
    ...adding.map((id) => [id, "adding"] as const)
  ])
  const pick: TilePick = {
    onOpen: (c) => workspace?.open(c.card.refId),
    onPick: (c) => add(c.card.entityId, c.card.label),
    label: (c, s) => labelOf(fullName(c), s),
    hint: (c, s) => hintOf(target, c.card.label, s),
    state: stateOf
  }
  // How many tiles are shown, for this search and filter: another starts from the first page.
  const pageKey = `${search}/${browse.filter}/${browse.withPersonas}`
  const [shown, setShown] = useState({ key: pageKey, count: PAGE })
  const count = shown.key === pageKey ? shown.count : PAGE
  const found = browseCards(browsable(data), browse, search)
  const cards = found.slice(0, count)
  return (
    <div className="flex flex-col gap-2 px-1">
      {/* Kept in view while the grid scrolls under it. */}
      <div
        data-layout-overlay="Add characters controls stay over the grid while it scrolls"
        className="sticky top-0 z-10 flex flex-col gap-2 bg-surface"
      >
        <Tooltip label="Shows the characters whose name or version has this in it">
          <Input
            ref={searchRef}
            type="search"
            aria-label="Find a character to add"
            placeholder="Find by name"
            className="max-w-controls"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </Tooltip>
        <CardBrowseBar data={data} browse={browse} onChange={setBrowse} includePersonas />
      </div>
      <CharacterGrid
        cards={cards}
        sort={browse.sort}
        markPersonas={mixesPersonas(browse)}
        pick={pick}
        status={status}
        // More columns as the panel widens, inside the search field’s insets.
        className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2 @3xl:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]"
      >
        {cards.length === 0 && (
          <p className="col-span-full py-2 text-sm text-muted">
            {browsable(data).length === 0
              ? "You have no characters yet."
              : browse.filter === "personas" && !search.trim()
                ? "You have no personas yet."
                : "No character matches."}
          </p>
        )}
      </CharacterGrid>
      <p
        role="status"
        className={said ? `text-xs ${said.tone === "failed" ? "text-danger" : "text-muted"}` : "sr-only"}
      >
        {said?.text ?? ""}
      </p>
      {found.length > count && (
        <Button
          variant="ghost"
          className="self-start"
          hint="Shows the next characters in this order"
          onClick={() => setShown({ key: pageKey, count: count + PAGE })}
        >
          Show {Math.min(PAGE, found.length - count)} more of {(found.length - count).toLocaleString()}
        </Button>
      )}
    </div>
  )
}

export function CastAddSection({ session }: { session: ChatSession }) {
  const target = useMemo(() => sessionTarget(session), [session])
  return <CastAdd target={target} />
}

/** The same Add characters in a chat not made yet (`pendingCastSections`). */
export function PendingCastAddSection({ pending }: { pending: PendingChat }) {
  const target = useMemo(() => pendingTarget(pending), [pending])
  return <CastAdd target={target} />
}

function CastAdd({ target }: { target: CastAddTarget }) {
  const userId = useSession().user.id
  const [open, setOpen] = useState(() => readCastAddOpen(userId))
  // Counts outside requests to add (the speaker switcher's "Add to chat"); 0 after a click here.
  const [focusSearch, setFocusSearch] = useState(0)
  const section = useRef<HTMLElement>(null)
  const id = useId()
  const toggle = (next: boolean) => {
    setOpen(next)
    setFocusSearch(0)
    writeCastAddOpen(userId, next)
  }
  // A request made before this mounted is taken now; one made while it's shown, when made.
  useEffect(() => {
    const take = () => {
      if (!takeCastAddRequest()) return
      setOpen(true)
      writeCastAddOpen(userId, true)
      setFocusSearch((n) => n + 1)
    }
    take()
    return subscribeCastAdd(take)
  }, [userId])
  useEffect(() => {
    if (focusSearch > 0) section.current?.scrollIntoView({ block: "start" })
  }, [focusSearch])
  return (
    <section ref={section} aria-labelledby={`${id}-title`} className="flex flex-col gap-2 border-t border-border pt-3">
      <h2 className="text-sm font-semibold">
        <Tooltip label={open ? "Click to hide characters to add" : "Click to show characters to add to this chat"}>
          <button
            type="button"
            id={`${id}-title`}
            aria-expanded={open}
            aria-controls={`${id}-body`}
            onClick={() => toggle(!open)}
            className="flex w-full items-center gap-1.5 rounded-md py-1 text-left outline-none select-none hover:text-accent focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon
              name="right"
              size={14}
              className={`shrink-0 text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
            />
            Add characters
          </button>
        </Tooltip>
      </h2>
      <div id={`${id}-body`} hidden={!open}>
        {/* The grid is made only once opened: hundreds of tiles most visits never look at. */}
        {open && (
          <AsyncView atom={shellAtom} loading="Loading your characters…" still="Still loading your characters…">
            {(data) => <AddGrid target={target} data={data} focusSearch={focusSearch} />}
          </AsyncView>
        )}
      </div>
    </section>
  )
}
