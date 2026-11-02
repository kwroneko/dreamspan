import { useNavigate, useSearch } from "@tanstack/react-router"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
import type { ChatNotePosition } from "@rp/shared/editorApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore
} from "react"
import { useSession } from "../../session.ts"
import { ColumnOverlay } from "../../ui/ColumnOverlay.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { useCaller } from "./caller.ts"
import { CARD_LOREBOOK_FOCUS } from "./cardSections.ts"
import { browserEnv } from "./backup.ts"
import { EditorStore, useEditorState } from "./store.ts"
import { type WorkspaceViewProps, workspaceViews } from "./workspaceViews.ts"

const Editor = lazy(() => import("./EditorPage.tsx").then((m) => ({ default: m.Editor })))
/** The chat the workspace is in, for what a card's save offers after it (a rename in the history). */
interface WorkspaceChat {
  readonly chatId: string
  readonly forkId: string | null
}
/**
 * The library entries edited from a chat: one store each, shared by the panel's tab and the
 * full editor, which opens over the chat's column (a preset, or a card from its panel tab).
 */
interface Workspace {
  /** A chat's own note is edited at its position, so its store is that position's. */
  store: (ref: RefId, chatNote?: ChatNotePosition) => EditorStore
  open: (ref: RefId, focus?: string) => void
  close: () => void
  selection: { ref: RefId; focus?: string | undefined } | null
  context: PresetContext | null | undefined
  chat: WorkspaceChat | undefined
}
const Context = createContext<Workspace | null>(null)
export const usePresetWorkspace = () => useContext(Context)

export function PresetWorkspace({
  children,
  context,
  chat,
  compact = false,
  onOpen
}: {
  children: ReactNode
  context?: PresetContext | null | undefined
  chat?: WorkspaceChat | undefined
  /** On a phone the full editor takes the side panel's place. */
  compact?: boolean
  onOpen?: () => void
}) {
  const call = useCaller()
  const userId = useSession().user.id
  const [stores] = useState(() => new Map<string, EditorStore>())
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()
  const selection = useMemo<Workspace["selection"]>(
    () =>
      typeof search.editor === "string" && search.editor
        ? { ref: search.editor as RefId, ...(typeof search.focus === "string" ? { focus: search.focus } : {}) }
        : null,
    [search.editor, search.focus]
  )
  const setSelection = (next: Workspace["selection"]) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        editor: next?.ref,
        focus: next?.focus,
        editorDialog: undefined,
        ...(next ? { [`cardBook:${next.ref}`]: undefined } : {}),
        ...(compact && next ? { panel: undefined } : {})
      }),
      state: (prev) => ({ ...prev, ...(compact && next ? { chatPanel: true } : {}) }),
      resetScroll: false
    })
  const notifyOpen = useEffectEvent(() => onOpen?.())
  // Also reconcile when an already open editor crosses into the phone layout: otherwise
  // the side panel becomes a modal sheet over it and makes the editor inert.
  useEffect(() => {
    if (selection !== null) notifyOpen()
  }, [selection, compact])
  const store = (ref: RefId, chatNote?: ChatNotePosition) => {
    const key = chatNote ? `${ref}\n${chatNote.chatId}\n${chatNote.forkId ?? ""}\n${chatNote.slotId ?? ""}` : ref
    let value = stores.get(key)
    if (!value) {
      value = new EditorStore(ref, userId, call, browserEnv, chatNote)
      stores.set(key, value)
    }
    return value
  }
  return (
    <Context
      value={{
        store,
        context,
        chat,
        selection,
        close: () => setSelection(null),
        open: (ref, focus) => {
          setSelection({ ref, focus })
        }
      }}
    >
      {children}
    </Context>
  )
}

export function PresetOverlayHost({
  page = false,
  session,
  view
}: { page?: boolean } & Pick<WorkspaceViewProps, "session" | "view">) {
  const workspace = usePresetWorkspace()
  const selection = workspace?.selection
  const views = useSyncExternalStore(workspaceViews.subscribe, workspaceViews.snapshot, workspaceViews.snapshot)
  if (!selection) return null
  // A feature's own view for this focus (a snippet's, a note's), in place of the library editor.
  const registered = selection.focus === undefined ? undefined : views.entries.find((v) => v.id === selection.focus)
  if (registered)
    return (
      <ColumnOverlay page={page} onClose={workspace.close} label={registered.label}>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-(--scroll-pad) [--scroll-pad:0.75rem] sm:[--scroll-pad:1rem]"
          data-testid="preset-scroll"
        >
          <registered.component
            key={selection.ref}
            refId={selection.ref}
            onClose={workspace.close}
            session={session}
            view={view}
          />
        </div>
      </ColumnOverlay>
    )
  return <WorkspaceOverlay workspace={workspace} selection={selection} page={page} />
}

function WorkspaceOverlay({
  workspace,
  selection,
  page
}: {
  workspace: Workspace
  selection: NonNullable<Workspace["selection"]>
  page: boolean
}) {
  const store = workspace.store(selection.ref)
  const kind = useEditorState(store).snapshot?.ref.kind
  return (
    <ColumnOverlay
      page={page}
      onClose={workspace.close}
      label={
        // A card opened on its own book is that book's editor.
        kind === "lorebook" || (kind === "card" && selection.focus === CARD_LOREBOOK_FOCUS)
          ? "Lorebook editor"
          : kind === "card"
            ? "Card editor"
            : kind === "note"
              ? "Note editor"
              : "Preset editor"
      }
    >
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-(--scroll-pad) [--scroll-pad:0.75rem] sm:[--scroll-pad:1rem]"
        data-testid="preset-scroll"
        data-preset-scroll
      >
        <Suspense fallback={<Loading label="Opening the editor…" />}>
          <Editor
            key={selection.ref}
            refId={selection.ref}
            suppliedStore={store}
            context={workspace.context}
            focus={selection.focus}
            current={workspace.chat}
            onClose={workspace.close}
          />
        </Suspense>
      </div>
    </ColumnOverlay>
  )
}
