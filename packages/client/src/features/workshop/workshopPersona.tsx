// The workshop persona (owner, 2026-11-12: "the workshop persona selection is separate from the RP
// persona selection"): who the user is in new workshops, set from a persona's menu beside the
// story default and never changing it. A workshop's own persona changes only that workshop.
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useAction } from "../../actions.tsx"
import { MenuAction, useMenuActions } from "../../ui/Menu.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { cardContributions, type CardSurfaceContext } from "../cardForks/surfaces.tsx"
import { shellAtom } from "../characters/shellData.tsx"
import type { ChatCardActionProps } from "../chat/CardForkDialogs.tsx"
import { chatCardActions } from "../chat/presentation.tsx"
import { AppClient } from "../../rpc.ts"

const workshopDefaultsAtom = AppClient.query(
  "GetWorkshopDefaults",
  {},
  {
    reactivityKeys: ["settings", "library"],
    timeToLive: "400 millis"
  }
)

const WORKSHOP_PERSONA_HINT = "New workshops start with this persona. Your stories' default persona doesn't change."
const CLEAR_HINT = "New workshops start with no persona. Your stories' default persona doesn't change."

function WorkshopPersonaAction({ entityId }: CardSurfaceContext) {
  const shell = useAtomValue(shellAtom)
  if (!AsyncResult.isSuccess(shell) || !shell.value.personas.some((c) => c.card.entityId === entityId)) return null
  return <LiveWorkshopPersonaAction entityId={entityId} />
}

function LiveWorkshopPersonaAction({ entityId }: CardSurfaceContext) {
  const defaults = useAtomValue(workshopDefaultsAtom)
  const current = AsyncResult.isSuccess(defaults) ? defaults.value.persona : null
  const action = useAction()
  const clear = current === entityId
  return (
    <MenuAction
      hint={clear ? CLEAR_HINT : WORKSHOP_PERSONA_HINT}
      disabled={action.pending}
      onClick={() =>
        void action
          .run((client) => client("SetWorkshopPersona", { persona: clear ? null : entityId }), ["settings"])
          .then((result) => {
            if (!result.ok)
              showToast({ title: "Couldn’t change the workshop persona", description: result.error.message })
          })
      }
    >
      {clear ? "Clear workshop persona" : "Set as workshop persona"}
    </MenuAction>
  )
}

function ChatWorkshopPersonaAction({ card }: ChatCardActionProps) {
  const inMenu = useMenuActions()
  return inMenu ? <WorkshopPersonaAction entityId={card.entityId} /> : null
}

export const registerWorkshopPersona = () => [
  chatCardActions.register({ id: "workshop.persona", order: 36, component: ChatWorkshopPersonaAction }),
  cardContributions.register({
    id: "workshop.persona",
    placement: "actions",
    overflow: true,
    order: 36,
    component: WorkshopPersonaAction,
    menu: WorkshopPersonaAction
  })
]
