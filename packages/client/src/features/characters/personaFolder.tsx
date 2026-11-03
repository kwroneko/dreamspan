// A card in or out of the persona folder (DESIGN §2.2, owner 2026-11-02): one action, used by
// the Persona toggle in a card's header (the chat panel's character tab and the full editor,
// `CardHeader`) and on its page, and by the library item menu's Persona tick. The toggle is the
// `characters.persona-folder` entry of `cardContributions` (placement "header"), so a plugin can
// replace or remove it. The shell read reloads after a change, so every list, filter and
// badge follows.
import { useAtomValue } from "@effect/atom-react"
import type { EntityId } from "@rp/shared/chat.ts"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { useAction } from "../../actions.tsx"
import { PersonaToggle } from "../../ui/PersonaToggle.tsx"
import { showToast } from "../../ui/Toast.tsx"
import type { CardSurfaceContext } from "../cardForks/surfaces.tsx"
import { shellAtom } from "./shellData.tsx"

export const PERSONA_FOLDER_HINT = "Keeps this card in the persona folder, so you can play it in chats."

/** Puts a card in the persona folder or takes it out; says so when that fails. */
export function useSetPersona() {
  const action = useAction()
  const set = async (entityId: EntityId | string, persona: boolean) => {
    const result = await action.run(
      (client) => client("SetPersona", { entityId: entityId as EntityId, persona }),
      ["library"]
    )
    if (!result.ok) showToast({ title: "Couldn’t change the persona folder", description: result.error.message })
    return result.ok
  }
  return { set, pending: action.pending }
}

/** Whether the shell lists the card under personas; null while it's read, or for a card it doesn't list. */
function usePersonaFolder(entityId: string): boolean | null {
  const shell = useAtomValue(shellAtom)
  if (!AsyncResult.isSuccess(shell)) return null
  if (shell.value.personas.some((c) => c.card.entityId === entityId)) return true
  return shell.value.cards.some((c) => c.card.entityId === entityId) ? false : null
}

/** Persona membership is shown at once, until the shell read agrees. */
export function PersonaFolderSwitch({ entityId }: CardSurfaceContext) {
  const listed = usePersonaFolder(entityId)
  const { set, pending } = useSetPersona()
  const [shown, setShown] = useState<boolean | null>(null)
  if (shown !== null && shown === listed && !pending) setShown(null)
  if (listed === null) return null
  const on = shown ?? listed
  return (
    <div data-persona-folder className="flex">
      <PersonaToggle
        pressed={on}
        pending={pending}
        onPressedChange={(next) => {
          setShown(next)
          void set(entityId, next).then((ok) => {
            if (!ok) setShown(null)
          })
        }}
      />
    </div>
  )
}
