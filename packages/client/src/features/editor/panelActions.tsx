import { useState } from "react"
import { defineSlot } from "../../slots.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { useCaller } from "./caller.ts"
import { RevisionsDialog } from "./RevisionsDialog.tsx"
import type { EditorStore } from "./store.ts"

/** Document actions beside Search and replace in the compact editors. */
export const panelEditorActions = defineSlot<{ store: EditorStore }>("editor.panel.actions")

export function PanelHistory({ store }: { store: EditorStore }) {
  const [open, setOpen] = useState(false)
  const call = useCaller()
  return (
    <>
      <Button
        className="h-8! px-2!"
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
