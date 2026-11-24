// "New workshop with this card" in a card's menus (spec/WORKSHOP-CARDS.md §3, unit C1): opens the
// workshop not made yet with the card as its assistant, which speaks as it, as a story's character
// does (owner, 2026-11-24). Beside "Set as workshop persona" in the library's and the editor's
// More menus and in a chat's Cast row menu; a persona isn't offered, as the Assistant picker
// doesn't offer one.
import { useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { MenuAction, useMenuActions } from "../../ui/Menu.tsx"
import { cardContributions, type CardSurfaceContext } from "../cardForks/surfaces.tsx"
import { shellAtom } from "../characters/shellData.tsx"
import type { ChatCardActionProps } from "../chat/CardForkDialogs.tsx"
import { chatCardActions } from "../chat/presentation.tsx"
import { WORKSHOP_CARD_KEY } from "./workshopStart.ts"

const HINT = "Starts a workshop whose assistant is this card, as a story starts with a character."

function NewWorkshopWithCard({ entityId }: CardSurfaceContext) {
  const shell = useAtomValue(shellAtom)
  const navigate = useNavigate()
  if (!AsyncResult.isSuccess(shell) || shell.value.personas.some((c) => c.card.entityId === entityId)) return null
  return (
    <MenuAction
      hint={HINT}
      href={`/new/workshop?${new URLSearchParams({ [WORKSHOP_CARD_KEY]: entityId })}`}
      onClick={() => void navigate({ to: "/new/workshop", search: { [WORKSHOP_CARD_KEY]: entityId as EntityId } })}
    >
      New workshop with this card
    </MenuAction>
  )
}

function ChatNewWorkshopWithCard({ card, persona }: ChatCardActionProps) {
  const inMenu = useMenuActions()
  return inMenu && !persona ? <NewWorkshopWithCard entityId={card.entityId} /> : null
}

export const registerWorkshopWithCard = () => [
  chatCardActions.register({ id: "workshop.with-card", order: 35, component: ChatNewWorkshopWithCard }),
  cardContributions.register({
    id: "workshop.with-card",
    placement: "actions",
    overflow: true,
    order: 35,
    component: NewWorkshopWithCard,
    menu: NewWorkshopWithCard
  })
]
