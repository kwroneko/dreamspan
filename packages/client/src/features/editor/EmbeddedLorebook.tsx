import { valueField } from "@rp/shared/editing.ts"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { FieldTools } from "./controls.tsx"
import { LorebookForm } from "./LorebookForm.tsx"
import type { EditorStore } from "./store.ts"

const BOOK = ["character_book"]

/** Registered card section. Every edit uses the card's existing field drafts. */
export function EmbeddedLorebook({ store }: { store: EditorStore }) {
  return (
    <Card>
      <CardHeader
        title="Embedded lorebook"
        description="Travels with this card on export and is used automatically in new chats. Changes are drafts until you save the card."
      />
      <div className="flex min-w-0 flex-col gap-4">
        <LorebookForm store={store} root={BOOK} absent="This card has no embedded lorebook." />
        <FieldTools store={store} field={valueField(BOOK)} label="Embedded lorebook" />
      </div>
    </Card>
  )
}
