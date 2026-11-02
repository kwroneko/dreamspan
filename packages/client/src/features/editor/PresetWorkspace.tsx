import { useNavigate, useSearch } from "@tanstack/react-router"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
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
  useState
} from "react"
import { useSession } from "../../session.ts"
import { ColumnOverlay } from "../../ui/ColumnOverlay.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { useCaller } from "./caller.ts"
import { CARD_LOREBOOK_FOCUS } from "./cardSections.ts"
import { EditorStore, useEditorState } from "./store.ts"

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
  store: (ref: RefId) => EditorStore
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
  const [stores] = useState(() => new Map<RefId, EditorStore>())
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
  const store = (ref: RefId) => {
    let value = stores.get(ref)
    if (!value) {
      value = new EditorStore(ref, userId, call)
      stores.set(ref, value)
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

export function PresetOverlayHost({ page = false }: { page?: boolean }) {
  const workspace = usePresetWorkspace()
  const selection = workspace?.selection
  if (!selection) return null
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
