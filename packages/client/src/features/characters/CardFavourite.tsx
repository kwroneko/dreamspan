import { CardSurface } from "../cardForks/surfaces.tsx"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { type EditorStore, useEditorState } from "../editor/store.ts"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { shellAtom } from "./shellData.tsx"
import { FavouriteStar } from "./cardBrowse.tsx"

/** A card's favourite star and archive toggle, side by side, beside its name. */
export function CardFavourite({ entityId, gap = "gap-1" }: { entityId: string; gap?: string }) {
  const shell = useAtomValue(shellAtom)
  const card = AsyncResult.isSuccess(shell)
    ? [...shell.value.cards, ...shell.value.personas, ...shell.value.archived].find((c) => c.card.entityId === entityId)
    : undefined
  // One group, so a wrapping row (the side panel's) never parts the star from the archive. Its
  // gap is its row's (`gap`), so the star, archive and the row's other buttons sit evenly apart.
  return card ? (
    <span className={`inline-flex shrink-0 items-center ${gap}`}>
      <FavouriteStar card={card} />
      <CardSurface placement="archive-toggle" entityId={entityId as EntityId} />
    </span>
  ) : null
}

export function PanelFavourite({ store }: { store: EditorStore }) {
  const ref = useEditorState(store).snapshot?.ref
  return ref?.kind === "card" ? <CardFavourite entityId={ref.entityId} gap="gap-2" /> : null
}
