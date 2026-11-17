import { addedTo } from "./StandaloneLorebook.tsx"
import { RefVariants } from "./RefVariants.tsx"
import { CenterHeaderContent, compactHeaderControls } from "../../ui/CenterHeader.tsx"
import { DocumentSwitcher } from "./DocumentSwitcher.tsx"
import { SearchReplaceButton } from "../../ui/SearchReplace.tsx"
import { PersonaBadge } from "../../ui/PersonaBadge.tsx"
import { useCast } from "../chat/cast.ts"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { CardSurface } from "../cardForks/surfaces.tsx"
import { useCardNameCheck } from "./cardNameCheck.ts"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
// A library entry's editor (ARCHITECTURE.md §14): which entry and scope you're editing, how
// many chats the change reaches, and the save cluster (DESIGN §10.1).
import { useAtomValue } from "@effect/atom-react"
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
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { WindowClose } from "../../ui/WindowClose.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { Alert, Badge, Card } from "../../ui/Surface.tsx"
import { useSession } from "../../session.ts"
import { useTitle } from "../shell.tsx"
import { CardFavourite } from "../characters/CardFavourite.tsx"
import { shellAtom } from "../characters/shellData.tsx"
import { useCaller } from "./caller.ts"
import { RecoveredNotice, RestoredNotice } from "./controls.tsx"
import { CardEditor } from "./CardEditor.tsx"
import { CardHeader, CardNameHeader, CardTokensRow } from "./CardNameHeader.tsx"
import { CARD_TAB_LOREBOOK } from "./cardTabs.ts"
import { StorePortrait } from "./PortraitControls.tsx"
import { EnsurePortraitViewer } from "../../ui/Portrait.tsx"
import { useWorkbench, useWorkbenchTab } from "../workbench/tab.tsx"
import { BoundScroll, ChatBoundEditor, Region } from "./PresetWorkspace.tsx"
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
import { editorActions, editorNotices } from "./editorSlots.ts"

const CARD_BOOK = ["character_book"]

const KINDS: Record<string, string> = { card: "card", preset: "preset", note: "note", lorebook: "lorebook" }

type Open = "history" | "search" | "fork" | null

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** How many chats use it. */
const usedBy = (chats: number) =>
  chats === 0 ? "No chat uses it yet." : chats === 1 ? "Used by 1 chat." : `Used by ${chats} chats.`

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
  const [presetToolbar, setPresetToolbar] = useState<HTMLDivElement | null>(null)
  const searching = dialog === "search"
  const setSearching = (next: boolean) => setDialog(next ? "search" : "")
  const searchButton = useRef<HTMLButtonElement>(null)
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
          <Tooltip label="Opens the library.">
            <Link to="/library" className="text-accent underline-offset-4 hover:underline">
              Library
            </Link>
          </Tooltip>
        </p>
      </Alert>
    )
  if (state.loadError) {
    return (
      <ErrorAlert
        error={state.loadError}
        actions={
          <Button hint="Retries loading this view." variant="ghost" onClick={() => void store.load()}>
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
  /** The entry's name, renamed in place (a card's name is its own field), and what kind it is. */
  const title = (size: string) => (
    <div className="flex w-full min-w-0 items-center gap-2">
      <h1 aria-label={bookOnly ? bookTitle : ref.label} className={`min-w-24 flex-1 ${size} font-semibold`}>
        {bookOnly ? (
          <BookName store={store} root={CARD_BOOK} fallback={`${ref.label}'s lorebook`}>
            <DocumentSwitcher refId={ref.id} label={bookTitle} kind="lorebook" />
          </BookName>
        ) : ref.kind === "card" ? (
          ref.label
        ) : ref.kind === "lorebook" ? (
          <BookName store={store} root={[]} fallback={ref.label}>
            <DocumentSwitcher refId={ref.id} label={ref.label} kind={ref.kind} />
          </BookName>
        ) : (
          <RefName store={store}>
            <DocumentSwitcher refId={ref.id} label={ref.label} kind={ref.kind} />
          </RefName>
        )}
      </h1>
      {(ref.kind !== "card" || bookOnly) && <Badge>{bookOnly ? "lorebook" : (KINDS[ref.kind] ?? ref.kind)}</Badge>}
      {ref.kind === "card" && !bookOnly && <CardFavourite entityId={ref.entityId} />}
      {ref.kind !== "card" && ref.parentEntityId !== null && <Badge tone="accent">variant</Badge>}
    </div>
  )

  // Opened from a chat, it scrolls on its own below the tab's header.
  const Scroll = onClose ? BoundScroll : Fragment
  // Named for what it edits, as a region of the page (a tab of its own in the workbench).
  const region =
    ref.kind === "lorebook" || bookOnly
      ? "Lorebook editor"
      : ref.kind === "card"
        ? "Card editor"
        : ref.kind === "note"
          ? "Note editor"
          : ref.kind === "preset"
            ? "Preset editor"
            : "Editor"
  return (
    <SearchNavigation value={searchMatch}>
      <Region label={region} className={onClose ? "flex min-h-0 flex-1 flex-col" : "contents"}>
        <Scroll>
          <div ref={root} className="flex flex-col gap-6">
            <header
              className={
                onClose && ref.kind === "preset" && variants.length <= 1 && !ref.subtitle
                  ? "hidden"
                  : "flex flex-col gap-1"
              }
            >
              {onClose ? null : (
                <Tooltip label="Returns to the library.">
                  <Link to="/library" className="text-sm text-muted underline-offset-4 hover:text-text hover:underline">
                    ← Library
                  </Link>
                </Tooltip>
              )}
              {/* Identity and document actions go to the column header. A card's names retain
              their rename questions (CardNameHeader). */}
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
                    saveControls={
                      <SaveRevision
                        store={store}
                        shownNameClash={clash}
                        onSaved={(saved) => setNotice(savedNotice(saved))}
                      />
                    }
                    store={store}
                    call={call}
                    current={current}
                    heading="h1"
                    centerTitle={<DocumentSwitcher refId={ref.id} label={workingName || ref.label} kind="card" />}
                    centerAfter={onClose && <WindowClose onClick={onClose} />}
                    after={<CardFavourite entityId={ref.entityId} />}
                  />
                  <CardTokensRow store={store} entityId={ref.entityId} label={ref.label} />
                </CardHeader>
              ) : (
                <CenterHeaderContent>
                  <div
                    data-editor-header
                    className={`flex w-full min-w-0 items-center justify-between gap-2 ${compactHeaderControls}`}
                  >
                    <div className="min-w-0 flex-1">{title("text-base")}</div>
                    <SaveRevision store={store} onSaved={(saved) => setNotice(savedNotice(saved))} />
                    {onClose && <WindowClose onClick={onClose} />}
                  </div>
                </CenterHeaderContent>
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
                    <Tooltip label="Shows every card field.">
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
                    </Tooltip>
                  </>
                ) : ref.kind === "preset" ? null : ref.kind === "lorebook" ? (
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
              <RefVariants store={store} />
            </header>

            <div
              ref={toolbar}
              // Whether typing is still on its way to the server: for tests, never shown.
              data-keeping={state.saving ? "true" : "false"}
              data-layout-overlay="Sticky editor toolbar covers scrolled document content"
              className="sticky top-[calc(var(--scroll-pad,0px)*-1)] z-10 flex flex-col gap-2 border-b border-border bg-canvas/95 py-2 backdrop-blur"
            >
              {ref.kind === "preset" ? (
                <div ref={setPresetToolbar} />
              ) : (
                <div className="flex flex-wrap items-center gap-1 sm:gap-2 max-sm:[&_button]:px-2.5">
                  <SearchReplaceButton
                    ref={searchButton}
                    open={searching}
                    controls="editor-search"
                    onClick={() => setSearching(!searching)}
                  />
                  <Button hint="Every saved revision, to compare or restore." onClick={() => setOpen("history")}>
                    History
                  </Button>
                  {ref.kind === "card" && (
                    <CardSurface placement="actions" overflow={false} entityId={ref.entityId} store={store} />
                  )}
                  {ref.kind !== "card" ? (
                    ref.kind !== "note" && (
                      <>
                        <Button
                          hint="A named copy with its own changes. Later changes to this one can be merged into it."
                          onClick={() => setOpen("fork")}
                        >
                          Make a variant
                        </Button>
                        <SlotOutlet slot={editorActions} props={{ store }} />
                      </>
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
                </div>
              )}
              {clash && (
                <p role="status" className="text-sm text-muted">
                  {clash}
                </p>
              )}
              {ref.kind === "preset" && <HeldChangesBar store={store} />}
              {ref.kind !== "preset" && searching && (
                <SearchDialog
                  store={store}
                  inline
                  idPrefix="editor-search"
                  scopes={scopes}
                  onReveal={setSearchMatch}
                  onClose={() => {
                    setSearching(false)
                    searchButton.current?.focus()
                  }}
                />
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
                  <Button hint="Dismisses this notice." variant="ghost" onClick={() => setNotice(null)}>
                    Dismiss
                  </Button>
                }
              >
                <p>{notice}</p>
              </Alert>
            )}
            <SlotOutlet slot={editorNotices} props={{ store }} />

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
            {ref.kind === "preset" && (
              <PresetEditor
                store={store}
                call={call}
                context={context}
                focus={focus}
                toolbarTarget={presetToolbar}
                onSearchReveal={setSearchMatch}
                toolbarEnd={
                  <>
                    <Button
                      className="h-8! px-2!"
                      aria-label="History"
                      hint="Every saved revision, to compare or restore."
                      onClick={() => setOpen("history")}
                    >
                      <Icon name="history" />
                      <span>History</span>
                    </Button>
                    <Button
                      className="h-8! px-2!"
                      aria-label="Make a variant"
                      hint="Makes a named copy with its own changes."
                      onClick={() => setOpen("fork")}
                    >
                      <Icon name="branch" />
                      <span>Make a variant</span>
                    </Button>
                    <SlotOutlet slot={editorActions} props={{ store }} />
                  </>
                }
              />
            )}
            {ref.kind === "note" && (
              <Card>
                <NoteFields store={store} />
              </Card>
            )}
            {ref.kind === "lorebook" && <SlotOutlet slot={lorebookEditorSections} props={{ store, call }} />}

            {open === "history" && <RevisionsDialog store={store} call={call} onClose={() => setOpen(null)} />}
            {open === "fork" && <ForkDialog store={store} onClose={() => setOpen(null)} />}
          </div>
        </Scroll>
      </Region>
    </SearchNavigation>
  )
}

export function EditorPage() {
  const { refId }: { refId?: string } = useParams({ strict: false })
  // `?focus=lorebook` opens a card on its own lorebook, as the chat's workspace does.
  const { focus, chat } = useSearch({ strict: false }) as { focus?: unknown; chat?: unknown }
  // A feature's own view of the entry (a snippet's large editor), opened with its focus.
  const views = useSyncExternalStore(workspaceViews.subscribe, workspaceViews.snapshot, workspaceViews.snapshot)
  const tab = useWorkbenchTab()
  const workbench = useWorkbench()
  const own = views.entries.find((view) => view.page === true && view.id === focus)
  const shownFocus = typeof focus === "string" ? focus : undefined
  // Opened from a chat (PresetWorkspace): the chat's stores and context while it's open, and
  // a Close that returns to it.
  if (typeof chat === "string" && chat) {
    const close = tab && workbench ? () => workbench.close(tab.tabId) : undefined
    return (
      <EnsurePortraitViewer>
        <ChatBoundEditor key={refId} refId={refId as RefId} focus={shownFocus} chatId={chat} onClose={close}>
          {(bound) =>
            own && !bound.session ? (
              <BoundScroll>
                <own.component refId={refId as RefId} />
              </BoundScroll>
            ) : (
              <Editor
                refId={refId as RefId}
                focus={shownFocus}
                {...(bound.store ? { suppliedStore: bound.store } : {})}
                context={bound.context}
                current={bound.current}
                {...(close ? { onClose: close } : {})}
              />
            )
          }
        </ChatBoundEditor>
      </EnsurePortraitViewer>
    )
  }
  if (own) return <own.component key={refId} refId={refId as RefId} />
  return (
    <EnsurePortraitViewer>
      <Editor key={refId} refId={refId as RefId} focus={shownFocus} />
    </EnsurePortraitViewer>
  )
}
