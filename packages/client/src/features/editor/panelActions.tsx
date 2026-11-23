import type { RefId } from "@dreamspan/shared/library.ts"
import { createContext, useContext, useState } from "react"
import { defineSlot } from "../../slots.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { useCaller } from "./caller.ts"
import { RevisionsDialog } from "./RevisionsDialog.tsx"
import { type EditorStore, useEditorState } from "./store.ts"
import { ForkDialog } from "./RefDialogs.tsx"
import { useOpenPlace } from "./durable.tsx"

export const PanelVariantNavigation = createContext<((ref: RefId) => void) | undefined>(undefined)

/** Document actions beside Search and replace in the compact editors. */
export const panelEditorActions = defineSlot<{ store: EditorStore }>("editor.panel.actions")

export function PanelHistory({ store }: { store: EditorStore }) {
  const [open, setOpen] = useState(false)
  const call = useCaller()
  return (
    <>
      <Button
        className="h-8! px-2! @max-[30rem]:w-8 @max-[30rem]:px-0!"
        aria-label="History"
        aria-pressed={open}
        hint="Shows saved revisions to compare or restore."
        onClick={() => setOpen(true)}
      >
        <Icon name="history" />
        <span className="@max-[30rem]:hidden">History</span>
      </Button>
      {open && <RevisionsDialog store={store} call={call} onClose={() => setOpen(false)} />}
    </>
  )
}

/** Uses the same variant action and dialog as the full lorebook editor. */
export function PanelVariant({ store }: { store: EditorStore }) {
  const onCreated = useContext(PanelVariantNavigation)
  const snapshot = useEditorState(store).snapshot
  // URL state, so a reload opens the form again with its names (a durable draft).
  const [open, setOpen] = useOpenPlace(`variant:${store.refId}`)
  if (snapshot?.ref.kind !== "lorebook") return null
  return (
    <>
      <Button
        className="h-8! px-2! @max-[30rem]:w-8 @max-[30rem]:px-0!"
        aria-label="Make a variant"
        hint="Makes a named copy of this lorebook with its own changes."
        onClick={() => setOpen(true)}
      >
        <Icon name="branch" />
        <span className="@max-[30rem]:hidden">Make a variant</span>
      </Button>
      {open && <ForkDialog store={store} onClose={() => setOpen(false)} {...(onCreated ? { onCreated } : {})} />}
    </>
  )
}
