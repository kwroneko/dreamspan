// Account default for new chats only. The registered badge, picker menu and card menu share
// one settings read/write; changing a pending chat's persona never calls this action.
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useAction } from "../../actions.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuAction, useMenuActions } from "../../ui/Menu.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { iconButtonClass, Tooltip } from "../../ui/Tooltip.tsx"
import { cardContributions, type CardSurfaceContext } from "../cardForks/surfaces.tsx"
import type { ChatCardActionProps } from "../chat/CardForkDialogs.tsx"
import { chatCardActions } from "../chat/presentation.tsx"
import { defaultsAtom } from "../pickers/defaults.ts"
import { shellAtom } from "./shellData.tsx"

const DEFAULT_PERSONA_HINT = "New chats start with this persona. Existing chats keep theirs."
const CLEAR_HINT = "New chats start with no persona."

export function useDefaultPersona() {
  const defaults = useAtomValue(defaultsAtom)
  return AsyncResult.isSuccess(defaults) ? (defaults.value.persona ?? null) : null
}

function DefaultPersonaBadge({ entityId }: CardSurfaceContext) {
  const current = useDefaultPersona()
  return current === entityId ? (
    <Tooltip label={DEFAULT_PERSONA_HINT}>
      <span
        tabIndex={0}
        data-default-persona
        className="inline-flex w-fit shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Badge>Default</Badge>
      </span>
    </Tooltip>
  ) : null
}

function DefaultPersonaAction({ entityId }: CardSurfaceContext) {
  const shell = useAtomValue(shellAtom)
  if (!AsyncResult.isSuccess(shell) || !shell.value.personas.some((c) => c.card.entityId === entityId)) return null
  return <LiveDefaultPersonaAction entityId={entityId} />
}

/** Only a live persona subscribes to the setting or offers its write action. */
function LiveDefaultPersonaAction({ entityId }: CardSurfaceContext) {
  const current = useDefaultPersona()
  const action = useAction()
  const clear = current === entityId
  return (
    <MenuAction
      hint={clear ? CLEAR_HINT : DEFAULT_PERSONA_HINT}
      disabled={action.pending}
      onClick={() =>
        void action
          .run(
            (client) => client("ChangeGenerationDefaults", { change: { persona: clear ? null : entityId } }),
            ["settings"]
          )
          .then((result) => {
            if (!result.ok)
              showToast({ title: "Couldn’t change the default persona", description: result.error.message })
          })
      }
    >
      {clear ? "Clear default persona" : "Set as default persona"}
    </MenuAction>
  )
}

/** This slot also renders inline on a character tab; the default belongs in its menu only. */
function ChatDefaultPersonaAction({ card }: ChatCardActionProps) {
  const inMenu = useMenuActions()
  return inMenu ? <DefaultPersonaAction entityId={card.entityId} /> : null
}

/** A separate menu beside the row's pick action, so setting a default never picks a persona. */
function DefaultPersonaMenu(context: CardSurfaceContext) {
  return (
    <Menu
      label={`Persona actions for ${context.label ?? "this card"}`}
      hint="Choose the persona for new chats."
      trigger={
        <Tooltip label="Opens persona actions for this card.">
          <button
            type="button"
            aria-label={`Persona actions for ${context.label ?? "this card"}`}
            className={iconButtonClass()}
          >
            <Icon name="more" />
          </button>
        </Tooltip>
      }
    >
      <DefaultPersonaAction {...context} />
    </Menu>
  )
}

export const registerDefaultPersona = () => {
  chatCardActions.register({
    id: "characters.default-persona",
    order: 35,
    component: ChatDefaultPersonaAction
  })
  for (const placement of ["badge", "persona-badge"] as const)
    cardContributions.register({
      id: `characters.default-persona.${placement}`,
      placement,
      order: 5,
      component: DefaultPersonaBadge
    })
  cardContributions.register({
    id: "characters.default-persona.picker",
    placement: "persona-menu",
    order: 5,
    component: DefaultPersonaMenu
  })
  cardContributions.register({
    id: "characters.default-persona",
    placement: "actions",
    overflow: true,
    order: 35,
    component: DefaultPersonaAction,
    menu: DefaultPersonaAction
  })
}
