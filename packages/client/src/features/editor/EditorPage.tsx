import { CardSurface } from "../cardForks/surfaces.tsx"
import { useCardNameCheck } from "./cardNameCheck.ts"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
// A library entry's editor (ARCHITECTURE.md §14): which entry and scope you're editing, how
// many chats the change reaches, and the state you're in: saved, or changes kept as drafts.
import { useAtomValue } from "@effect/atom-react"
import type { ChatId } from "@rp/shared/chat.ts"
import type { SavedRef } from "@rp/shared/editorApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Link, useParams } from "@tanstack/react-router"
import { lorebookEditorSections } from "./cardSections.ts"
import { SlotOutlet } from "../../slots.tsx"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useMemo, useRef, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { Alert, Badge, Card } from "../../ui/Surface.tsx"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { chatName, formatDay } from "../chat/chatTitle.ts"
import { useTitle } from "../shell.tsx"
import { useCaller } from "./caller.ts"
import { RecoveredNotice, RestoredNotice } from "./controls.tsx"
import { CardEditor } from "./CardEditor.tsx"
import { NoteFields } from "./notes.tsx"
import { PresetEditor } from "./PresetEditor.tsx"
import { ForkDialog, RenameDialog } from "./RefDialogs.tsx"
import { RevisionsDialog } from "./RevisionsDialog.tsx"
import { SaveDialog } from "./SaveDialog.tsx"
import { SearchNavigation, type SearchMatch } from "./searchNavigation.ts"
import { SearchDialog } from "./SearchDialog.tsx"
import { EditorStore, useEditorState, useLeaveGuard, useText } from "./store.ts"
import { UpdateDialog } from "./UpdateDialog.tsx"

const KINDS: Record<string, string> = { card: "card", preset: "preset", note: "note", lorebook: "lorebook" }

type Open = "save" | "history" | "search" | "fork" | "rename" | "update" | null

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** What saving reaches, in one line: the chats using it, and how to change it for some only. */
const usedBy = (chats: number, some: string | null) =>
  chats === 0
    ? "No chat uses it yet."
    : chats === 1
      ? `Used by 1 chat: saving changes it there.`
      : `Used by ${chats} chats: saving changes it in all of them.${some ? ` To change it in some only, ${some}.` : ""}`

/**
 * A lorebook's line: the chats it was added to. A global one is read in every chat besides,
 * which its "Use in every chat" switch just below says (`LorebookUse`).
 */
const addedTo = (chats: number) =>
  chats === 0
    ? "Not added to any chat yet."
    : chats === 1
      ? "Added to 1 chat: saving changes it there."
      : `Added to ${chats} chats: saving changes it in all of them. To change it in some only, make a variant.`

/** What saving did to the refs that follow this one. */
const savedNotice = (saved: SavedRef) => {
  const setAside = saved.setAside.length
  const merged = saved.followers.filter((f) => f.outcome === "fast_forward" || f.outcome === "merged").length
  const conflicts = saved.followers.filter((f) => f.outcome === "conflicts").length
  return [
    "Saved a revision.",
    merged > 0
      ? `${plural(merged, "entry that follows this one", "entries that follow this one")} took the change.`
      : "",
    conflicts > 0 ? `${plural(conflicts, "variant has", "variants have")} conflicts to resolve in its own editor.` : "",
    setAside > 0
      ? `${plural(setAside, "change was", "changes were")} in something deleted since, so ${setAside === 1 ? "it's" : "they're"} in the bin's recovered texts instead.`
      : ""
  ]
    .filter((part) => part !== "")
    .join(" ")
}

/** The chat a chat override belongs to, by name, as a link back to it. */
function OverrideChat({ chatId, prefix = "" }: { chatId: ChatId; prefix?: string }) {
  const result = useAtomValue(useMemo(() => AppClient.query("GetChat", { chatId }), [chatId]))
  const name = AsyncResult.isSuccess(result) ? chatName(result.value.title, []) : null
  return (
    <Link to="/chats/$chatId" params={{ chatId }} className="text-accent underline-offset-4 hover:underline">
      {prefix}
      {name ? `${name.name}${name.started ? ` (started ${formatDay(name.started)})` : ""}` : "the chat"}
    </Link>
  )
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
  /** The chat it's opened over, for the rename offer after a card's save. */
  current?: { readonly chatId: string; readonly forkId: string | null } | undefined
  onClose?: () => void
}) {
  const call = useCaller()
  const userId = useSession().user.id
  const [store] = useState(() => suppliedStore ?? new EditorStore(refId, userId, call))
  const [searchMatch, setSearchMatch] = useState<SearchMatch | null>(null)
  const [open, setOpen] = useState<Open>(null)
  // A preset's search sits in the sticky bar, so its matches stay beside the document; it's
  // folded away until asked for.
  const [searching, setSearching] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
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
  useTitle(state.snapshot?.ref.label ?? "Editor")
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
  const { dirty } = state

  const upload = async (file: File) => {
    setUploadError(null)
    const response = await fetch(`/library/avatar?ref=${ref.id}&rowVersion=${ref.rowVersion}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file
    })
    if (response.ok) return store.refresh()
    const body = (await response.json().catch(() => ({}))) as { error?: unknown }
    setUploadError(typeof body.error === "string" ? body.error : "The avatar couldn't be uploaded.")
  }

  return (
    <SearchNavigation value={searchMatch}>
      <div className="flex flex-col gap-6">
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
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-2xl font-semibold [overflow-wrap:anywhere]">{ref.label}</h1>
            {ref.kind !== "card" && <Badge>{KINDS[ref.kind] ?? ref.kind}</Badge>}
            {ref.kind !== "card" && ref.refKind !== "upstream" && (
              <Badge tone={ref.refKind === "variant" ? "accent" : "neutral"}>
                {ref.refKind === "variant" ? "variant" : "edited for this chat"}
              </Badge>
            )}
          </div>
          {ref.kind === "card" && <CardSurface placement="provenance" entityId={ref.entityId} />}
          {ref.subtitle && <p className="text-muted [overflow-wrap:anywhere]">{ref.subtitle}</p>}
          <p className="text-sm text-muted">
            {ref.kind === "preset" ? (
              "Saving changes this prompt preset in every chat that uses it."
            ) : ref.chatId !== null ? (
              // A chat override (DESIGN §4): this chat's own version of the entry.
              <>
                Only <OverrideChat chatId={ref.chatId} /> uses this version; the original's later changes still reach it
                where you haven't edited the same text.
              </>
            ) : ref.kind === "lorebook" ? (
              addedTo(usedByChats)
            ) : (
              usedBy(usedByChats, ref.kind === "card" ? "fork it" : ref.kind === "note" ? null : "make a variant")
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
          className="sticky top-[calc(var(--scroll-pad,0px)*-1)] z-10 flex flex-col gap-2 border-b border-border bg-canvas/95 py-2 backdrop-blur"
        >
          {onClose &&
            (ref.kind === "preset" ? (
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{ref.label}</span>
                <Button className="shrink-0" onClick={onClose}>
                  Close preset editor
                </Button>
              </div>
            ) : (
              // A card's name is the heading just above: the bar keeps only the way back.
              <div>
                <Button variant="ghost" className="-ml-2 h-8 gap-1.5 px-2" onClick={onClose}>
                  <Icon name="back" />
                  Back to the chat
                </Button>
              </div>
            ))}
          <div className="flex flex-wrap items-center gap-1 sm:gap-2">
            <Button variant="primary" disabled={dirty === 0 || clash !== null} onClick={() => setOpen("save")}>
              Save{dirty > 0 ? ` (${dirty})` : ""}
            </Button>
            {ref.kind !== "preset" && <Button onClick={() => setOpen("search")}>Search</Button>}
            <Button onClick={() => setOpen("history")}>History</Button>
            {ref.kind === "card" && (
              <CardSurface placement="actions" overflow={false} entityId={ref.entityId} store={store} />
            )}
            {ref.kind === "preset" ? (
              <>
                {ref.refKind !== "chat_override" && <Button onClick={() => setOpen("fork")}>Make a variant</Button>}
                <Button variant="ghost" onClick={() => setOpen("rename")}>
                  Rename
                </Button>
              </>
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
                  {ref.kind === "card" && (
                    <CardSurface placement="actions" overflow entityId={ref.entityId} store={store} />
                  )}
                  {ref.kind !== "card" && ref.kind !== "note" && ref.refKind !== "chat_override" && (
                    <Button onClick={() => setOpen("fork")}>Make a variant</Button>
                  )}
                  {ref.kind !== "card" && <Button onClick={() => setOpen("rename")}>Rename</Button>}
                </div>
              </Popover>
            )}
            <p role="status" className="text-sm text-muted sm:ml-auto">
              {state.saving
                ? "Keeping your changes…"
                : dirty === 0
                  ? "Everything is saved."
                  : `${plural(dirty, "field has", "fields have")} changes, kept as drafts until you save a revision.`}
            </p>
          </div>
          {clash && (
            <p role="status" className="text-sm text-muted">
              {clash}
            </p>
          )}
          {/* A preset's search toggle sits on its own line under the bar: on a phone the bar's buttons fill a row. */}
          {ref.kind === "preset" && (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                className="h-7! shrink-0 px-2!"
                aria-expanded={searching}
                aria-controls="preset-search"
                onClick={() => setSearching(!searching)}
              >
                <Icon name="search" />
                Search
              </Button>
            </div>
          )}
          {ref.kind === "preset" && searching && (
            <div id="preset-search">
              <SearchDialog store={store} inline onReveal={setSearchMatch} />
            </div>
          )}
        </div>

        {state.saveError && (
          <ErrorAlert
            error={{ ...state.saveError, message: `A change couldn't be kept: ${state.saveError.message}` }}
          />
        )}
        {uploadError && (
          <Alert tone="danger" title="The avatar wasn't changed">
            <p>{uploadError}</p>
          </Alert>
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

        {ref.kind === "card" && <CardSurface placement="family" entityId={ref.entityId} whenForked />}
        {ref.kind === "card" && <CardEditor store={store} call={call} onUpload={(file) => void upload(file)} />}
        {ref.kind === "preset" && <PresetEditor store={store} call={call} context={context} focus={focus} />}
        {ref.kind === "note" && (
          <Card>
            <NoteFields store={store} />
          </Card>
        )}
        {ref.kind === "lorebook" && <SlotOutlet slot={lorebookEditorSections} props={{ store, call }} />}

        {open === "save" && (
          <SaveDialog
            store={store}
            current={current}
            onClose={() => setOpen(null)}
            onSaved={(saved) => {
              setOpen(null)
              setNotice(savedNotice(saved))
            }}
          />
        )}
        {open === "history" && <RevisionsDialog store={store} call={call} onClose={() => setOpen(null)} />}
        {open === "search" && <SearchDialog store={store} onClose={() => setOpen(null)} onReveal={setSearchMatch} />}
        {open === "fork" && <ForkDialog store={store} onClose={() => setOpen(null)} />}
        {open === "update" && <UpdateDialog store={store} call={call} onClose={() => setOpen(null)} />}
        {open === "rename" && (
          <RenameDialog
            store={store}
            onClose={() => setOpen(null)}
            onRenamed={() => {
              setOpen(null)
              void store.refresh()
            }}
          />
        )}
      </div>
    </SearchNavigation>
  )
}

export function EditorPage() {
  const { refId }: { refId?: string } = useParams({ strict: false })
  return <Editor key={refId} refId={refId as RefId} />
}
