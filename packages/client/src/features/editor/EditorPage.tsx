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
import { GlobalLorebook } from "./GlobalLorebook.tsx"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useMemo, useRef, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
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
  onClose
}: {
  refId: RefId
  suppliedStore?: EditorStore
  context?: PresetContext | null | undefined
  focus?: string | undefined
  onClose?: () => void
}) {
  const call = useCaller()
  const userId = useSession().user.id
  const [store] = useState(() => suppliedStore ?? new EditorStore(refId, userId, call))
  const [searchMatch, setSearchMatch] = useState<SearchMatch | null>(null)
  const [open, setOpen] = useState<Open>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
  if (state.snapshot === null) return <Loading label="Opening the editor…" />
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
        <header className="flex flex-col gap-2">
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
            <Badge>{KINDS[ref.kind] ?? ref.kind}</Badge>
            {ref.kind !== "card" && (
              <Badge tone={ref.refKind === "variant" ? "accent" : "neutral"}>
                {ref.refKind === "variant"
                  ? "variant"
                  : ref.refKind === "upstream"
                    ? "original"
                    : "edited for this chat"}
              </Badge>
            )}
          </div>
          {ref.kind === "card" && <CardSurface placement="provenance" entityId={ref.entityId} />}
          {ref.subtitle && <p className="text-muted [overflow-wrap:anywhere]">{ref.subtitle}</p>}
          {ref.kind === "preset" ? (
            <p className="text-sm">
              Saving updates this prompt preset everywhere. Choose the current prompt preset in the composer; it applies
              across your chats.
            </p>
          ) : ref.chatId !== null ? (
            // A chat override (DESIGN §4): this chat's own version of the entry.
            <p className="text-sm">
              <strong>Edited for this chat.</strong> This version of the {KINDS[ref.kind]} is used only in{" "}
              <OverrideChat chatId={ref.chatId} />, and saving changes it only there; other chats keep the original.
              Changes to the original still reach it where you haven't edited the same text.
            </p>
          ) : (
            <p className="text-sm">
              Saving changes this {ref.refKind === "variant" ? "variant" : KINDS[ref.kind]} everywhere it's used:{" "}
              <strong>used by {plural(usedByChats, "chat", "chats")}</strong>.
              {ref.kind === "card"
                ? " To change it for some chats only, fork it."
                : ref.kind !== "note" && " To change it for some chats only, make a variant."}
            </p>
          )}
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
          className="sticky top-[calc(var(--scroll-pad,0px)*-1)] z-10 -mx-4 flex flex-col gap-2 border-b border-border bg-canvas/95 px-4 py-2 backdrop-blur sm:mx-0 sm:rounded-lg sm:border sm:px-3"
        >
          {onClose && (
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{ref.label}</span>
              <Button className="shrink-0" onClick={onClose}>
                Close preset editor
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={dirty === 0 || clash !== null} onClick={() => setOpen("save")}>
              Save{dirty > 0 ? ` (${dirty})` : ""}
            </Button>
            {ref.kind !== "preset" && <Button onClick={() => setOpen("search")}>Search</Button>}
            <Button onClick={() => setOpen("history")}>History</Button>
            {ref.kind === "card" && <CardSurface placement="actions" entityId={ref.entityId} store={store} />}
            {ref.kind !== "card" && ref.kind !== "note" && ref.refKind !== "chat_override" && (
              <Button onClick={() => setOpen("fork")}>Make a variant</Button>
            )}
            {ref.kind !== "card" && (
              <Button variant="ghost" onClick={() => setOpen("rename")}>
                Rename
              </Button>
            )}
          </div>
          {clash && (
            <p role="status" className="text-sm text-muted">
              {clash}
            </p>
          )}
          {ref.kind === "preset" && <SearchDialog store={store} inline onReveal={setSearchMatch} />}
          <p role="status" className="text-sm text-muted">
            {state.saving
              ? "Keeping your changes…"
              : dirty === 0
                ? "Everything is saved."
                : `${plural(dirty, "field has", "fields have")} changes, kept as drafts until you save a revision.`}
          </p>
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
        <RecoveredNotice count={state.recovered} />
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

        {ref.kind === "card" && <CardSurface placement="family" entityId={ref.entityId} />}
        {ref.kind === "card" && <CardEditor store={store} call={call} onUpload={(file) => void upload(file)} />}
        {ref.kind === "preset" && <PresetEditor store={store} call={call} context={context} focus={focus} />}
        {ref.kind === "note" && (
          <Card>
            <NoteFields store={store} />
          </Card>
        )}
        {ref.kind === "lorebook" && (
          <Card>
            <GlobalLorebook refId={ref.id} call={call} />
          </Card>
        )}
        {ref.kind === "lorebook" && (
          <Alert title="Lorebooks can't be edited here yet">
            <p>
              <Link to="/library" className={buttonClass("ghost")}>
                Back to the library
              </Link>
            </p>
          </Alert>
        )}

        {open === "save" && (
          <SaveDialog
            store={store}
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
