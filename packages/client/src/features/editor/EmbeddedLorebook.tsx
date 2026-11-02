import { valueField } from "@rp/shared/editing.ts"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { FieldTools } from "./controls.tsx"
import { LorebookForm } from "./LorebookForm.tsx"
import type { EditorStore } from "./store.ts"

const BOOK = ["character_book"]

/**
 * Registered card section (`CARD_LOREBOOK_SECTION`). Every edit uses the card's existing field
 * drafts. `data-card-lorebook` is where the editor scrolls when it leaves the book's own view.
 */
export function EmbeddedLorebook({ store }: { store: EditorStore }) {
  return (
    <div data-card-lorebook className="scroll-mt-[var(--preset-toolbar-height,1rem)]">
      <Card>
        <CardHeader title="Embedded lorebook" />
        <div className="flex min-w-0 flex-col gap-4">
          <LorebookForm store={store} root={BOOK} absent="This card has no embedded lorebook." />
          <FieldTools store={store} field={valueField(BOOK)} label="Embedded lorebook" />
        </div>
      </Card>
    </div>
  )
}
