import type { PresetContext } from "@rp/shared/inspectorApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { createContext, lazy, type ReactNode, Suspense, useContext, useState } from "react"
import { useSession } from "../../session.ts"
import { ColumnOverlay } from "../../ui/ColumnOverlay.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { useCaller } from "./caller.ts"
import { EditorStore } from "./store.ts"

const Editor = lazy(() => import("./EditorPage.tsx").then((m) => ({ default: m.Editor })))
interface Workspace {
  store: (ref: RefId) => EditorStore
  open: (ref: RefId, focus?: string) => void
  close: () => void
  selection: { ref: RefId; focus?: string | undefined } | null
  context: PresetContext | null | undefined
}
const Context = createContext<Workspace | null>(null)
export const usePresetWorkspace = () => useContext(Context)

export function PresetWorkspace({
  children,
  context,
  onOpen
}: {
  children: ReactNode
  context?: PresetContext | null | undefined
  onOpen?: () => void
}) {
  const call = useCaller()
  const userId = useSession().user.id
  const [stores] = useState(() => new Map<RefId, EditorStore>())
  const [selection, setSelection] = useState<Workspace["selection"]>(null)
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
        selection,
        close: () => setSelection(null),
        open: (ref, focus) => {
          setSelection({ ref, focus })
          onOpen?.()
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
  return (
    <ColumnOverlay page={page} onClose={workspace.close}>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-(--scroll-pad) [--scroll-pad:0.75rem] sm:[--scroll-pad:1rem]"
        data-testid="preset-scroll"
        data-preset-scroll
      >
        <Suspense fallback={<Loading label="Opening preset…" />}>
          <Editor
            key={selection.ref}
            refId={selection.ref}
            suppliedStore={workspace.store(selection.ref)}
            context={workspace.context}
            focus={selection.focus}
            onClose={workspace.close}
          />
        </Suspense>
      </div>
    </ColumnOverlay>
  )
}
