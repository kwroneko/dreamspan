import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { Card } from "../../ui/Surface.tsx"
import type { Caller } from "./caller.ts"
import { GlobalLorebook } from "./GlobalLorebook.tsx"
import { LorebookForm } from "./LorebookForm.tsx"
import { type EditorStore, useValue } from "./store.ts"

const BOOK: ReadonlyArray<string> = []

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * Registered standalone lorebook section: how many entries it has, and the switch for every
 * chat. The chats it was added to are the editor's header line.
 */
export function LorebookUse({ store, call }: { store: EditorStore; call: Caller }) {
  const entries = useValue<LorebookDoc | undefined>(store, BOOK)?.entries.length ?? 0
  return (
    <section aria-label="Where it's used" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <p className="shrink-0 text-sm font-semibold">{count(entries, "entry", "entries")}</p>
      <GlobalLorebook refId={store.refId} call={call} />
    </section>
  )
}

/** Registered standalone lorebook section: the book's settings and its entries, as field drafts. */
export function StandaloneLorebook({ store }: { store: EditorStore }) {
  return (
    <Card>
      <LorebookForm store={store} root={BOOK} absent="This lorebook is empty." />
    </Card>
  )
}
