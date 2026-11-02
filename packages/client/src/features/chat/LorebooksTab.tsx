// The side panel's Lorebooks tab (DESIGN §1.3, §5.0): every book this chat reads in one list
// (lorebookRows.ts: each member card's own, those added to this chat, the preset's), each with
// its switch; picking a row opens that book below the list to read and edit (owner,
// 2026-11-01), one at a time; then where entries go.
// A card's or the chat's switch is a state event at the leaf shown, so from there on, on this
// branch. It shows at once and is confirmed in the background, put back with a message if it
// fails. A preset's book is switched in the preset, for every chat using it.
import type { PresetLorebook } from "@rp/shared/docs/preset.ts"
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import type { LibraryRef, RefId } from "@rp/shared/library.ts"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useId, useRef, useState } from "react"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { ActionMenu, type ActionMenuItem } from "../../ui/Menu.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { inlineExplanationClass } from "../../ui/Explanation.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { CARD_LOREBOOK_FOCUS } from "../editor/cardSections.ts"
import { useCardRefs, useLibraryLorebooks } from "../editor/libraryLorebooks.ts"
import { LorebookPanelEditor } from "../editor/LorebookPanelEditor.tsx"
import { LorebookPicker } from "../editor/LorebookPicker.tsx"
import { PRESET_LOREBOOKS_FOCUS } from "../editor/PresetLorebooks.tsx"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { useCaller } from "../editor/caller.ts"
import { EditorStore, useEditorState, useLeaveGuard, useValue } from "../editor/store.ts"
import { useSession } from "../../session.ts"
import { useCast } from "./cast.ts"
import { useChatPreset } from "./chatPreset.ts"
import { type BookRow, lorebookRows } from "./lorebookRows.ts"
import type { ChatSession, ChatView } from "./session.ts"

const entries = (count: number) => `${count.toLocaleString()} ${count === 1 ? "entry" : "entries"}`

const heading = "text-xs font-medium tracking-wide text-muted uppercase"

const NO_BOOKS: ReadonlyArray<PresetLorebook> = []

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
          {
            value: "below",
            label: "Below the history",
            description: "Every matching entry goes in one block just after the history, so the history stays cached."
          },
          {
            value: "positions",
            label: "Where each entry says",
            description:
              "Each entry goes where its own position says, as in SillyTavern. One above the history can make the provider read the whole history again."
          }
        ]}
      />
      <p className="text-sm text-muted">For every book in this chat.</p>
    </section>
  )
}

/** What a row shows and does, worked out from its source. */
interface Shown {
  readonly name: string
  readonly from: string
  readonly switchHint: string
  /** "From the preset X": a link into the preset. */
  readonly presetLink?: { readonly label: string; readonly open: () => void }
  /** The store and the book's place in it, for the editor below the list. */
  readonly edit: { readonly ref: RefId; readonly root: ReadonlyArray<string>; readonly note?: string } | null
  readonly focus?: string
  readonly menu: ReadonlyArray<ActionMenuItem>
}

/** A book: its switch, its name (picking it opens the book below the list) and its ⋯. */
function Book({
  row,
  shown,
  selected,
  onSelect,
  onSwitch
}: {
  row: BookRow
  shown: Shown
  selected: boolean
  onSelect: () => void
  onSwitch: (on: boolean) => void
}) {
  const hintId = useId()
  return (
    <li
      className={`flex items-start gap-1 rounded-md px-1 py-1.5 ${selected ? "bg-surface-raised ring-1 ring-accent/50" : ""}`}
      data-selected={selected || undefined}
      // Switched here, not confirmed yet: the row says so without changing its name.
      aria-busy={row.pending || undefined}
    >
      {/* Its explanation on hover and focus; on a phone it's under the book's name. */}
      <Tooltip label={shown.switchHint}>
        <span className="shrink-0 pt-1.5 pl-1">
          <Switch checked={row.on} onCheckedChange={onSwitch} describedBy={hintId}>
            <span className="sr-only">{shown.name}</span>
          </Switch>
        </span>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <Tooltip
          label={
            selected
              ? "Closes the book below the list."
              : "Opens the book below the list, to read and edit its entries here."
          }
        >
          <button
            type="button"
            aria-pressed={selected}
            disabled={!shown.edit}
            onClick={onSelect}
            className="flex w-full min-w-0 flex-col items-start rounded-md px-1.5 py-0.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-default disabled:hover:bg-transparent"
          >
            <span className="text-sm font-medium [overflow-wrap:anywhere]">{shown.name}</span>
            <span className="text-xs text-muted [overflow-wrap:anywhere]">{shown.from}</span>
          </button>
        </Tooltip>
        {shown.presetLink && (
          <Tooltip label="Opens the preset at its lorebooks: switching or removing it there changes every chat using the preset.">
            <button
              type="button"
              onClick={shown.presetLink.open}
              className="px-1.5 text-left text-xs text-accent underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            >
              {shown.presetLink.label}
            </button>
          </Tooltip>
        )}
        <p id={hintId} aria-hidden="true" className={`hidden px-1.5 text-xs text-muted ${inlineExplanationClass}`}>
          {shown.switchHint}
        </p>
      </div>
      {shown.menu.length > 0 ? (
        <ActionMenu label={`More for ${shown.name}`} trigger={<Icon name="more" />} items={shown.menu} />
      ) : (
        <span aria-hidden="true" className="w-8 shrink-0" />
      )}
    </li>
  )
}

/**
 * The preset the chat uses, its books as typed (live), kept loaded and flushed like its tab's.
 * Without one (yet), a store that's never loaded stands in, so the hooks stay the same.
 */
function usePresetBooks(store: EditorStore | null) {
  const call = useCaller()
  const userId = useSession().user.id
  const [none] = useState(() => new EditorStore("" as RefId, userId, call))
  const used = store ?? none
  const state = useEditorState(used)
  useEffect(() => {
    if (used !== none && used.snapshot === null) void used.load()
  }, [used, none])
  useLeaveGuard(used)
  const books = useValue<ReadonlyArray<PresetLorebook> | undefined>(used, ["lorebooks"]) ?? NO_BOOKS
  return { books: state.snapshot ? books : NO_BOOKS, label: state.snapshot?.ref.label ?? null }
}

export function LorebooksTab({ session, view, active }: { session: ChatSession; view: ChatView; active: boolean }) {
  const { cast, cards } = useCast()
  const library = useLibraryLorebooks()
  const cardRefs = useCardRefs()
  const workspace = usePresetWorkspace()
  const navigate = useNavigate()
  const preset = useChatPreset(session, view)
  const presetStore = preset.ref && workspace ? workspace.store(preset.ref) : null
  const { books: presetBooks, label: presetName } = usePresetBooks(presetStore)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  // Switches not confirmed yet, by row; each with the latest request's number, so an earlier
  // answer doesn't put a later switch back.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [requests] = useState(() => new Map<string, number>())

  const send = async (key: string, change: CastChange, on: boolean | null, failure: string) => {
    const seq = (requests.get(key) ?? 0) + 1
    requests.set(key, seq)
    if (on !== null) setPending((map) => new Map(map).set(key, on))
    const outcome = await session.changeCast(change)
    if (requests.get(key) !== seq) return
    setPending((map) => {
      const next = new Map(map)
      next.delete(key)
      return next
    })
    setError(outcome.ok ? null : `${failure}: ${outcome.error.message}`)
  }

  const own = (cast?.participants ?? []).flatMap((id) => {
    const card = cards.get(id)
    return card?.lorebook && !card.inBin ? [card] : []
  })
  const rows = lorebookRows({
    cards: own.map((card) => card.entityId),
    cardsOff: cast?.cardLorebooksOff ?? [],
    listed: cast?.listedLorebooks ?? [],
    preset: presetBooks,
    pending
  })
  const byId = new Map((library ?? []).map((ref) => [ref.id as string, ref]))
  const nameOf = (id: string) => byId.get(id)?.label ?? (library === null ? "…" : "A lorebook no longer in the library")
  const openPreset = () => preset.ref && workspace?.open(preset.ref, PRESET_LOREBOOKS_FOCUS)
  const presetLabel = presetName ? `From the preset ${presetName}` : "From the preset"

  const shownOf = (row: BookRow): Shown => {
    if (row.source === "card") {
      const card = cards.get(row.id)!
      const name = card.lorebookName ?? `${card.name}'s lorebook`
      const ref = cardRefs?.get(row.id)
      return {
        name,
        from: [
          row.on ? `${card.name}'s own lorebook` : `${card.name}'s own lorebook, off in this chat`,
          ...(card.lorebookEntries === undefined ? [] : [entries(card.lorebookEntries)])
        ].join(" · "),
        switchHint: `Off stops ${card.name}'s own book in this chat only, from the latest message on. The card keeps it, and its other chats still read it.`,
        edit: ref
          ? { ref: ref.id, root: ["character_book"], note: `Part of ${card.name}'s card: saving it saves the card.` }
          : null,
        focus: CARD_LOREBOOK_FOCUS,
        menu: []
      }
    }
    const ref = byId.get(row.id)
    const name = nameOf(row.id)
    if (row.source === "preset")
      return {
        name,
        from: row.on ? "Sent with the preset" : "In the preset, switched off there",
        switchHint: `Switches it in the preset ${presetName ?? ""}: every chat using that preset, as you switch it.`,
        presetLink: { label: presetLabel, open: openPreset },
        edit: ref ? { ref: ref.id, root: [] } : null,
        menu: []
      }
    return {
      name,
      from: [
        row.on
          ? "Added to this chat"
          : row.presetSends
            ? "Off in this chat, but the preset sends it"
            : "Off in this chat",
        ...(ref?.subtitle ? [ref.subtitle] : [])
      ].join(" · "),
      switchHint:
        "Off stops the book in this chat, from the latest message on; it stays listed here, off, until you remove it.",
      ...(row.presetSends ? { presetLink: { label: `Also ${presetLabel.toLowerCase()}`, open: openPreset } } : {}),
      edit: ref ? { ref: ref.id, root: [] } : null,
      menu: [
        {
          label: "Remove from this chat",
          description: "Takes it off this chat's list, from the latest message on. Add a lorebook brings it back.",
          tone: "danger",
          onSelect: () => {
            if (selected === row.key) setSelected(null)
            void send(row.key, { _tag: "RemoveLorebook", ref: row.id as RefId }, null, `Couldn't remove ${name}`)
          }
        }
      ]
    }
  }

  const switchRow = (row: BookRow, name: string, on: boolean) => {
    if (row.source === "preset") {
      presetStore?.switchLorebook(row.id, on)
      return
    }
    const change: CastChange =
      row.source === "card"
        ? { _tag: "CardLorebook", entityId: row.id as never, on }
        : { _tag: "Lorebook", ref: row.id as RefId, active: on }
    void send(row.key, change, on, `Couldn't switch ${name} ${on ? "on" : "off"}; it's back as it was`)
  }

  const chosen = rows.find((row) => row.key === selected)
  const chosenShown = chosen ? shownOf(chosen) : null
  // A book picked on a phone opens below the fold: its name is brought into view, the list
  // staying put when it already shows.
  const opened = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selected) opened.current?.scrollIntoView({ block: "nearest" })
  }, [selected])
  const openLarge = (shown: Shown) => {
    if (!shown.edit) return
    if (workspace) workspace.open(shown.edit.ref, shown.focus)
    else
      void navigate({
        to: "/library/$refId",
        params: { refId: shown.edit.ref },
        search: shown.focus ? { focus: shown.focus } : {}
      })
  }
  const addable = (library ?? []).filter((ref) => !(cast?.listedLorebooks ?? []).some((book) => book.ref === ref.id))
  void active

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
          <ul aria-label="Lorebooks in this chat" className="flex max-w-controls flex-col gap-0.5">
            {rows.map((row) => {
              const shown = shownOf(row)
              return (
                <Book
                  key={row.key}
                  row={row}
                  shown={shown}
                  selected={row.key === selected}
                  onSelect={() => setSelected(row.key === selected ? null : row.key)}
                  onSwitch={(on) => switchRow(row, shown.name, on)}
                />
              )
            })}
          </ul>
        )}
        {adding ? (
          <LorebookPicker
            title="Add a lorebook"
            lorebooks={addable}
            onPick={(ref: LibraryRef) => {
              setAdding(false)
              void send(
                `chat:${ref.id}`,
                { _tag: "Lorebook", ref: ref.id, active: true },
                true,
                `Couldn't add ${ref.label}`
              )
            }}
            onClose={() => setAdding(false)}
          />
        ) : (
          <div className="pt-1">
            <Button
              onClick={() => setAdding(true)}
              disabled={library === null}
              hint="Picks a book from your library for this chat to read, from the latest message on."
            >
              Add a lorebook
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </section>

      <Placement
        on={cast?.loreBelowHistory ?? true}
        onChange={(on) =>
          void send("placement", { _tag: "LoreBelowHistory", on }, null, "Couldn't change where entries go")
        }
      />
      <p className="text-sm text-muted">
        A chat's switches apply from the latest message on, on this branch; a preset's, in every chat using it.
      </p>

      {chosen && chosenShown?.edit && workspace && (
        <div ref={opened} className="scroll-mt-2 border-t border-border pt-4">
          <LorebookPanelEditor
            key={chosen.key}
            store={workspace.store(chosenShown.edit.ref)}
            root={chosenShown.edit.root}
            fallbackName={chosenShown.name}
            {...(chosenShown.edit.note ? { note: chosenShown.edit.note } : {})}
            onClose={() => setSelected(null)}
            onOpenLarge={() => openLarge(chosenShown)}
          />
        </div>
      )}
    </div>
  )
}
