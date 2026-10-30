import { Card, CardHeader } from "../../ui/Surface.tsx"
import type { Caller } from "./caller.ts"
import { GlobalLorebook } from "./GlobalLorebook.tsx"
import { LorebookForm } from "./LorebookForm.tsx"
import type { EditorStore } from "./store.ts"

/** Registered standalone lorebook section: whether every chat reads it. */
export function LorebookUse({ store, call }: { store: EditorStore; call: Caller }) {
  return (
    <Card>
      <GlobalLorebook refId={store.refId} call={call} />
    </Card>
  )
}

/** Registered standalone lorebook section: the book's settings and entries, as field drafts. */
export function StandaloneLorebook({ store }: { store: EditorStore }) {
  return (
    <Card>
      <CardHeader
        title="Entries"
        description="Each change is kept as a draft until you save a revision; History shows and restores earlier revisions."
      />
      <LorebookForm store={store} root={[]} absent="This lorebook is empty." />
    </Card>
  )
}
