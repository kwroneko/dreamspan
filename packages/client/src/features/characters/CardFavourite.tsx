import { type EditorStore, useEditorState } from "../editor/store.ts"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { shellAtom } from "./shellData.tsx"
import { FavouriteStar } from "./cardBrowse.tsx"

/** A character's favourite star beside its name; a persona (not on the shell's grids) has none. */
export function CardFavourite({ entityId }: { entityId: string }) {
  const shell = useAtomValue(shellAtom)
  const card = AsyncResult.isSuccess(shell) ? shell.value.cards.find((c) => c.card.entityId === entityId) : undefined
  return card ? <FavouriteStar card={card} /> : null
}

export function PanelFavourite({ store }: { store: EditorStore }) {
  const ref = useEditorState(store).snapshot?.ref
  return ref?.kind === "card" ? <CardFavourite entityId={ref.entityId} /> : null
}
