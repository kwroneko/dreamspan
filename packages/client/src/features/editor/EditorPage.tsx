import { PersonaBadge } from "../../ui/PersonaBadge.tsx"
import { useCast } from "../chat/cast.ts"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { CardSurface } from "../cardForks/surfaces.tsx"
import { useCardNameCheck } from "./cardNameCheck.ts"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
// A library entry's editor (ARCHITECTURE.md §14): which entry and scope you're editing, how
// many chats the change reaches, and the save cluster (DESIGN §10.1).
import { useAtomValue } from "@effect/atom-react"
import type { ChatId } from "@rp/shared/chat.ts"
import type { SavedRef } from "@rp/shared/editorApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Link, useParams, useSearch } from "@tanstack/react-router"
import {
  CARD_LOREBOOK_FOCUS,
  CARD_LOREBOOK_SECTION,
  cardEditorSections,
  lorebookEditorSections
} from "./cardSections.ts"
import { SlotOutlet } from "../../slots.tsx"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { Alert, Badge, Card } from "../../ui/Surface.tsx"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { chatName, formatDay } from "../chat/chatTitle.ts"
import { useTitle } from "../shell.tsx"
import { FavouriteStar } from "../characters/cardBrowse.tsx"
import { shellAtom } from "../characters/shellData.tsx"
import { useCaller } from "./caller.ts"
import { RecoveredNotice, RestoredNotice } from "./controls.tsx"
import { CardEditor } from "./CardEditor.tsx"
import { CardHeader, CardNameHeader, CardTokens } from "./CardNameHeader.tsx"
import { CARD_TAB_LOREBOOK } from "./cardTabs.ts"
import { StorePortrait } from "./PortraitControls.tsx"
import { EnsurePortraitViewer } from "../../ui/Portrait.tsx"
import { NoteFields } from "./notes.tsx"
import { workspaceViews } from "./workspaceViews.ts"
import { PresetEditor } from "./PresetEditor.tsx"
import { ForkDialog, RefName } from "./RefDialogs.tsx"
import { RevisionsDialog } from "./RevisionsDialog.tsx"
import { HeldChangesBar } from "./SaveRevert.tsx"
import { SaveRevision } from "./SaveRevision.tsx"
import { SearchNavigation, type SearchMatch } from "./searchNavigation.ts"
import { SearchDialog } from "./SearchDialog.tsx"
import { lorebookScopes, presetScopes } from "./searchScopes.ts"
import { BookName } from "./LorebookPanelEditor.tsx"
import { EditorStore, useEditorState, useLeaveGuard, useText } from "./store.ts"
import { UpdateDialog } from "./UpdateDialog.tsx"

const CARD_BOOK = ["character_book"]

const KINDS: Record<string, string> = { card: "card", preset: "preset", note: "note", lorebook: "lorebook" }

type Open = "history" | "search" | "fork" | "update" | null

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** How many chats use it. */
const usedBy = (chats: number) =>
  chats === 0 ? "No chat uses it yet." : chats === 1 ? "Used by 1 chat." : `Used by ${chats} chats.`

/**
 * A lorebook's line: the chats it was added to. The presets that send it are listed just below
 * it (`LorebookUse`).
 */
const addedTo = (chats: number) =>
  chats === 0 ? "Not added to any chat yet." : chats === 1 ? "Added to 1 chat." : `Added to ${chats} chats.`

/**
 * What saving did to the refs that follow this one, or null when it did nothing more than save:
 * Save's own tick says that (DESIGN §10.1).
 */
const savedNotice = (saved: SavedRef) => {
  const setAside = saved.setAside.length
  const merged = saved.followers.filter((f) => f.outcome === "fast_forward" || f.outcome === "merged").length
  const conflicts = saved.followers.filter((f) => f.outcome === "conflicts").length
  const parts = [
    merged > 0
      ? `${plural(merged, "entry that follows this one", "entries that follow this one")} took the change.`
      : "",
    conflicts > 0 ? `${plural(conflicts, "variant has", "variants have")} conflicts to resolve in its own editor.` : "",
    setAside > 0
      ? `Text from ${plural(setAside, "change", "changes")} to deleted entries is kept in the bin, under Recovered text.`
      : ""
  ].filter((part) => part !== "")
  return parts.length === 0 ? null : ["Saved.", ...parts].join(" ")
}

/** The chat a chat override belongs to, by name, as a link back to it. */
function OverrideChat({ chatId, prefix = "" }: { chatId: ChatId; prefix?: string }) {
  const result = useAtomValue(useMemo(() => AppClient.query("GetChat", { chatId }), [chatId]))
  const name = AsyncResult.isSuccess(result) ? chatName(result.value.title, [], result.value.createdAt) : null
  return (
    <Link to="/chats/$chatId" params={{ chatId }} className="text-accent underline-offset-4 hover:underline">
      {prefix}
      {name ? `${name.name}${name.started ? ` (started ${formatDay(name.started)})` : ""}` : "the chat"}
    </Link>
  )
}

/** A character's favourite star beside its name; a persona (not on the shell's grids) has none. */
function CardFavourite({ entityId }: { entityId: string }) {
  const shell = useAtomValue(shellAtom)
  const card = AsyncResult.isSuccess(shell) ? shell.value.cards.find((c) => c.card.entityId === entityId) : undefined
  return card ? <FavouriteStar card={card} /> : null
}

export function Editor({
  refId,
  suppliedStore,
  context,
  focus,
  current,
  onClose
}: {
  refId: RefId
  suppliedStore?: EditorStore
  context?: PresetContext | null | undefined
  focus?: string | undefined
  /** The chat it's opened over, for a rename's "only in this chat". */
  current?: { readonly chatId: string; readonly forkId: string | null } | undefined
  onClose?: () => void
}) {
  const cast = useCast()
  const shell = useAtomValue(shellAtom)
  const call = useCaller()
  const userId = useSession().user.id
  const [store] = useState(() => suppliedStore ?? new EditorStore(refId, userId, call))
  const [searchMatch, setSearchMatch] = useState<SearchMatch | null>(null)
  const [dialog, setDialog] = usePlaceParam("editorDialog", "", ["", "history", "search"])
  const [transient, setTransient] = useState<Open>(null)
  const open = transient ?? (dialog || null)
  const setOpen = (next: Open) => {
    if (next === "history" || next === "search" || next === null) {
      setTransient(null)
      setDialog(next ?? "")
    } else setTransient(next)
  }
  // A preset's search sits in the sticky bar, so its matches stay beside the document; it's
  // folded away until asked for.
  const [searching, setSearching] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  // A card opened on its own lorebook shows the book alone, in the large editor, until "Show
  // the whole card", which opens the card on its Lorebook tab.
  const [bookMode, setBookMode] = usePlaceParam(`cardBook:${refId}`, "", ["", "book", "card"])
  const bookView = bookMode === "book" || (bookMode !== "card" && focus === CARD_LOREBOOK_FOCUS)
  const setBookView = (on: boolean) => setBookMode(on ? "book" : "card")
  // Opened again from the panel while open: the new focus decides.
  const [lastFocus, setLastFocus] = useState(focus)
  if (focus !== lastFocus) {
    setLastFocus(focus)
  }
  // Back from the book's own view: the card opens on its Lorebook tab.
  const [cardTab, setCardTab] = useState<string | undefined>(undefined)
  const root = useRef<HTMLDivElement>(null)
  // The page shows the state: loads, and fields starting or ending unsaved changes.
  const state = useEditorState(store)
  const toolbar = useRef<HTMLDivElement>(null)
  const loaded = state.snapshot !== null
  useEffect(() => {
    const element = toolbar.current
    if (!element) return
    const measure = () =>
      element.parentElement?.style.setProperty("--preset-toolbar-height", `${element.offsetHeight + 16}px`)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [loaded])
  const bookOnly = bookView && state.snapshot?.ref.kind === "card"
  const bookName = useText(store, ["character_book", "name"])?.trim()
  const bookTitle = bookName || `${state.snapshot?.ref.label ?? ""}'s lorebook`
  useTitle(bookOnly ? bookTitle : (state.snapshot?.ref.label ?? "Editor"))
  const workingName = useText(store, ["name"]) ?? ""
  const workingVersion = useText(store, ["character_version"]) ?? ""
  const nameCheck = useCardNameCheck(workingName, workingVersion, state.snapshot?.ref)
  const clash = state.snapshot?.ref.kind === "card" ? nameCheck : null

  useEffect(() => {
    if (store.snapshot === null) void store.load()
  }, [store])
  useLeaveGuard(store)

  if (state.loadError?.tag === "NotFound")
    return (
      <Alert tone="warning">
        <p>
          This item was deleted or never existed ·{" "}
          <Link to="/library" className="text-accent underline-offset-4 hover:underline">
            Library
          </Link>
        </p>
      </Alert>
    )
  if (state.loadError) {
    return (
      <ErrorAlert
        error={state.loadError}
        actions={
          <Button variant="ghost" onClick={() => void store.load()}>
            Try again
          </Button>
        }
      />
    )
  }
  if (state.snapshot === null) return <Loading label="Opening the editor…" onRetry={() => void store.load()} />
  const { ref, usedByChats, variants } = state.snapshot

  /**
   * A preset's and a lorebook's search sits in the sticky bar, with what it looks in (owner,
   * 2026-11-01: text, names or keys, or both); other editors use the dialog.
   */
  const scopes =
    ref.kind === "preset"
      ? presetScopes
      : ref.kind === "lorebook"
        ? lorebookScopes([])
        : bookOnly
          ? lorebookScopes(CARD_BOOK)
          : undefined
  /** A preset's editor over the chat: its name lives in the sticky bar instead of a heading. */
  const overPreset = onClose !== undefined && ref.kind === "preset"
  /** The entry's name, renamed in place (a card's name is its own field), and what kind it is. */
  const title = (size: string) => (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <h1 className={`min-w-0 ${size} font-semibold [overflow-wrap:anywhere]`}>
        {bookOnly ? (
          <BookName store={store} root={CARD_BOOK} fallback={`${ref.label}'s lorebook`} />
        ) : ref.kind === "card" ? (
          ref.label
        ) : ref.kind === "lorebook" ? (
          <BookName store={store} root={[]} fallback={ref.label} />
        ) : (
          <RefName store={store} />
        )}
      </h1>
      {(ref.kind !== "card" || bookOnly) && <Badge>{bookOnly ? "lorebook" : (KINDS[ref.kind] ?? ref.kind)}</Badge>}
      {ref.kind === "card" && !bookOnly && <CardFavourite entityId={ref.entityId} />}
      {ref.kind !== "card" && ref.refKind !== "upstream" && (
        <Badge tone={ref.refKind === "variant" ? "accent" : "neutral"}>
          {ref.refKind === "variant" ? "variant" : "edited for this chat"}
        </Badge>
      )}
    </div>
  )

  return (
    <SearchNavigation value={searchMatch}>
      <div ref={root} className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          {onClose ? null : ref.chatId !== null ? (
            <span className="text-sm">
              <OverrideChat chatId={ref.chatId} prefix="← Back to " />
            </span>
          ) : (
            <Link to="/library" className="text-sm text-muted underline-offset-4 hover:text-text hover:underline">
              ← Library
            </Link>
          )}
          {/* Over a chat, a preset's name is in the sticky bar, once. A card's names are renamed
              in place, each with its own question (CardNameHeader). */}
          {ref.kind === "card" && !bookOnly ? (
            <CardHeader
              portrait={
                <StorePortrait
                  store={store}
                  call={call}
                  id={ref.entityId}
                  badge={
                    cast.cast?.playedByMe.includes(ref.entityId) ? (
                      <PersonaBadge played portrait />
                    ) : AsyncResult.isSuccess(shell) &&
                      shell.value.personas.some((p) => p.card.entityId === ref.entityId) ? (
                      <PersonaBadge portrait />
                    ) : undefined
                  }
                />
              }
            >
              <CardNameHeader
                store={store}
                call={call}
                current={current}
                heading="h1"
                after={<CardFavourite entityId={ref.entityId} />}
              />
              <CardTokens store={store} />
            </CardHeader>
          ) : (
            !overPreset && title("text-2xl")
          )}
          {ref.kind === "card" && !bookOnly && <CardSurface placement="provenance" entityId={ref.entityId} />}
          {ref.subtitle && ref.kind !== "card" && !bookOnly && (
            <p className="text-muted [overflow-wrap:anywhere]">{ref.subtitle}</p>
          )}
          <p className="text-sm text-muted">
            {bookOnly ? (
              // The book is part of the card's document: saved, versioned and exported with it.
              <>
                {ref.label}'s own lorebook.{" "}
                <button
                  type="button"
                  className="text-accent underline-offset-4 hover:underline"
                  onClick={() => {
                    setBookView(false)
                    setCardTab(CARD_TAB_LOREBOOK)
                  }}
                >
                  Show the whole card
                </button>
              </>
            ) : ref.kind === "preset" ? null : ref.chatId !== null ? (
              // A chat override (DESIGN §4): this chat's own version of the entry.
              <>
                Only <OverrideChat chatId={ref.chatId} /> uses this version; the original's later changes still reach it
                where you haven't edited the same text.
              </>
            ) : ref.kind === "lorebook" ? (
              addedTo(usedByChats)
            ) : ref.kind === "card" ? (
              <Tooltip label="Shows this card's chats.">
                <Link
                  to="/cards/$entityId"
                  params={{ entityId: ref.entityId }}
                  className="text-accent underline-offset-4 hover:underline"
                >
                  {usedBy(usedByChats)}
                </Link>
              </Tooltip>
            ) : (
              usedBy(usedByChats)
            )}
          </p>
          {ref.kind !== "card" && variants.length > 1 && (
            <nav aria-label="Variants" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-muted">Variants:</span>
              {variants.map((variant) =>
                variant.id === ref.id ? (
                  <span key={variant.id} aria-current="page" className="font-medium">
                    {variant.label}
                    {variant.subtitle ? ` · ${variant.subtitle}` : ""}
                  </span>
                ) : (
                  <Link
                    key={variant.id}
                    to="/library/$refId"
                    params={{ refId: variant.id }}
                    className="text-accent underline-offset-4 hover:underline"
                  >
                    {variant.label}
                    {variant.subtitle ? ` · ${variant.subtitle}` : ""}
                  </Link>
                )
              )}
            </nav>
          )}
        </header>

        <div
          ref={toolbar}
          // Whether typing is still on its way to the server: for tests, never shown.
          data-keeping={state.saving ? "true" : "false"}
          data-layout-overlay="Sticky editor toolbar covers scrolled document content"
          className="sticky top-[calc(var(--scroll-pad,0px)*-1)] z-10 flex flex-col gap-2 border-b border-border bg-canvas/95 py-2 backdrop-blur"
        >
          {onClose &&
            (ref.kind === "preset" ? (
              <div className="flex min-w-0 items-center justify-between gap-2">
                {title("text-base")}
                <Tooltip label="Back to the chat; unsaved changes stay as drafts">
                  <Button className="shrink-0" onClick={onClose}>
                    Close preset editor
                  </Button>
                </Tooltip>
              </div>
            ) : (
              // A card's name is the heading just above: the bar keeps only the way back.
              <div>
                <Button
                  variant="ghost"
                  className="h-8 gap-1.5 px-2"
                  hint="Closes the editor and returns to the chat."
                  onClick={onClose}
                >
                  <Icon name="back" />
                  Back to the chat
                </Button>
              </div>
            ))}
          <div className="flex flex-wrap items-center gap-1 sm:gap-2 max-sm:[&_button]:px-2.5">
            <SaveRevision store={store} onSaved={(saved) => setNotice(savedNotice(saved))} />
            {!scopes && (
              <Button hint="Find and replace text in every field." onClick={() => setOpen("search")}>
                Search
              </Button>
            )}
            <Button hint="Every saved revision, to compare or restore." onClick={() => setOpen("history")}>
              History
            </Button>
            {ref.kind === "card" && (
              <CardSurface placement="actions" overflow={false} entityId={ref.entityId} store={store} />
            )}
            {ref.kind !== "card" ? (
              ref.kind !== "note" &&
              ref.refKind !== "chat_override" && (
                <Button
                  hint="A named copy with its own changes, which still gets this one's updates."
                  onClick={() => setOpen("fork")}
                >
                  Make a variant
                </Button>
              )
            ) : (
              // What's used less, grouped; each opens its own dialog.
              <Popover
                open={more}
                onOpenChange={setMore}
                trigger={
                  <span className="flex items-center gap-1">
                    More
                    <Icon name="down" />
                  </span>
                }
                triggerLabel="More actions"
                title="More actions"
                triggerClassName={buttonClass("secondary")}
                side="bottom"
                align="end"
                keepMounted
              >
                <div
                  className="flex flex-col items-stretch gap-1 *:justify-start [&_button]:w-full [&_button]:justify-start"
                  onClickCapture={() => setMore(false)}
                >
                  <CardSurface placement="actions" overflow entityId={ref.entityId} store={store} />
                </div>
              </Popover>
            )}
            {/* A preset's search toggle ends the row (unitGPreset keeps the sticky bar under 400 px). */}
            <div className="flex min-w-0 items-center justify-end gap-2 sm:ml-auto">
              {scopes && (
                <Button
                  variant="ghost"
                  className="h-7! shrink-0 px-2!"
                  aria-expanded={searching}
                  aria-controls="preset-search"
                  hint={
                    ref.kind === "preset"
                      ? "Find and replace in the prompts' text, their names, or anywhere in the preset."
                      : "Find and replace in the entries' text, their keys, or anywhere in the book."
                  }
                  onClick={() => setSearching(!searching)}
                >
                  <Icon name="search" />
                  Search
                </Button>
              )}
            </div>
          </div>
          {clash && (
            <p role="status" className="text-sm text-muted">
              {clash}
            </p>
          )}
          {ref.kind === "preset" && <HeldChangesBar store={store} />}
          {scopes && searching && (
            <div id="preset-search">
              <SearchDialog store={store} inline scopes={scopes} onReveal={setSearchMatch} />
            </div>
          )}
        </div>

        {state.saveError && (
          <ErrorAlert
            error={{ ...state.saveError, message: `A change couldn't be kept: ${state.saveError.message}` }}
          />
        )}
        <RestoredNotice count={state.restored} />
        <RecoveredNotice store={store} />
        {notice && (
          <Alert
            tone="success"
            actions={
              <Button variant="ghost" onClick={() => setNotice(null)}>
                Dismiss
              </Button>
            }
          >
            <p>{notice}</p>
          </Alert>
        )}
        {ref.updateAvailable && (
          <Alert
            tone="warning"
            title={
              ref.refKind === "upstream"
                ? "A newer version of the file was imported"
                : "What this variant follows changed"
            }
            actions={<Button onClick={() => setOpen("update")}>Review the update</Button>}
          >
            <p>It isn't in this {KINDS[ref.kind]} yet.</p>
          </Alert>
        )}

        {bookOnly && <SlotOutlet slot={cardEditorSections} props={{ store, call }} only={CARD_LOREBOOK_SECTION} />}
        {ref.kind === "card" && !bookOnly && <CardSurface placement="family" entityId={ref.entityId} whenForked />}
        {ref.kind === "card" && !bookOnly && (
          <CardEditor
            store={store}
            call={call}
            layout="page"
            {...(cardTab ? { initial: cardTab, reveal: true } : {})}
            onOpenBook={() => setBookView(true)}
          />
        )}
        {ref.kind === "preset" && <PresetEditor store={store} call={call} context={context} focus={focus} />}
        {ref.kind === "note" && (
          <Card>
            <NoteFields store={store} />
          </Card>
        )}
        {ref.kind === "lorebook" && <SlotOutlet slot={lorebookEditorSections} props={{ store, call }} />}

        {open === "history" && <RevisionsDialog store={store} call={call} onClose={() => setOpen(null)} />}
        {open === "search" && <SearchDialog store={store} onClose={() => setOpen(null)} onReveal={setSearchMatch} />}
        {open === "fork" && <ForkDialog store={store} onClose={() => setOpen(null)} />}
        {open === "update" && <UpdateDialog store={store} call={call} onClose={() => setOpen(null)} />}
      </div>
    </SearchNavigation>
  )
}

export function EditorPage() {
  const { refId }: { refId?: string } = useParams({ strict: false })
  // `?focus=lorebook` opens a card on its own lorebook, as the chat's workspace does.
  const { focus } = useSearch({ strict: false }) as { focus?: unknown }
  // A feature's own view of the entry (a snippet's large editor), opened with its focus.
  const views = useSyncExternalStore(workspaceViews.subscribe, workspaceViews.snapshot, workspaceViews.snapshot)
  const own = views.entries.find((view) => view.page === true && view.id === focus)
  if (own) return <own.component key={refId} refId={refId as RefId} />
  return (
    <EnsurePortraitViewer>
      <Editor key={refId} refId={refId as RefId} focus={typeof focus === "string" ? focus : undefined} />
    </EnsurePortraitViewer>
  )
}
