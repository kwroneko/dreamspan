// "Family" beside History for presets and lorebooks (a card's family is under its Forks); the
// tree itself loads when opened.
import { lazy, Suspense, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { type EditorStore, useEditorState } from "../editor/store.ts"

const GenealogyDialog = lazy(() => import("./Genealogy.tsx").then((m) => ({ default: m.GenealogyDialog })))

/** "Family", beside History: presets and lorebooks (a card's family is under its Forks). */
export function FamilyButton({ store, compact }: { store: EditorStore; compact: boolean }) {
  const ref = useEditorState(store).snapshot?.ref
  const [open, setOpen] = useState(false)
  if (!ref || (ref.kind !== "preset" && ref.kind !== "lorebook")) return null
  return (
    <>
      <Button
        // The size of the buttons beside it: the panels' and the preset toolbar's are small.
        className={compact || ref.kind === "preset" ? "h-8! px-2!" : ""}
        aria-label="Family"
        aria-pressed={open}
        hint={`Shows where this ${ref.kind} was forked from and the forks made from it.`}
        onClick={() => setOpen(true)}
      >
        <Icon name="family" />
        <span className={compact ? "@max-[30rem]:hidden" : ""}>Family</span>
      </Button>
      {open && (
        <Suspense fallback={null}>
          <GenealogyDialog refId={ref.id} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
