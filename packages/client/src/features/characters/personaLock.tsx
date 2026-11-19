// The persona locked to a character (DESIGN §2.2, owner 2026-11-18: "an explicit lock
// per-character"): new single chats with them start as it instead of the account default.
// Set from a new single chat's persona picker (Always play as this with <Name>, the same
// switch row as the pickers' Lock for this chat); shown, and cleared, in the character's own
// tab in the chat panel. A lock never changes a chat that has started. Both parts are
// registered slot entries, so a plugin can replace or drop either.
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { useSyncExternalStore } from "react"
import { useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { PickerLockRow } from "../pickers/PickerParts.tsx"
import type { PendingChat } from "../chat/pendingChat.ts"
import { chatCharacterRows, pendingPersonaPickerRows } from "../chat/presentation.tsx"

/** Writes of a lock name this; "library" also reads it again when a persona card changes. */
const LOCK_KEY = "persona-lock"

const lockAtom = Atom.family((entityId: string) =>
  entityId === ""
    ? Atom.make(AsyncResult.success<CastCard | null>(null))
    : AppClient.query(
        "GetPersonaLock",
        { entityId: entityId as EntityId },
        { reactivityKeys: [LOCK_KEY, "library"], timeToLive: "2 minutes" }
      )
)

/** The persona locked to a character, once read (null: none, or not read yet). */
const usePersonaLock = (entityId: EntityId | null) => {
  const result = useAtomValue(lockAtom(entityId ?? ""))
  return AsyncResult.isSuccess(result) ? { ready: true, persona: result.value } : { ready: false, persona: null }
}

const lockHint = (name: string) => `New chats with ${name} start with this persona. Chats already started keep theirs.`

/** At the top of a new single chat's persona picker: lock the persona picked to its character. */
function PendingPersonaLock({ pending }: { pending: PendingChat }) {
  const state = useSyncExternalStore(pending.subscribe, pending.snapshot)
  const card = pending.lockCard
  const lock = usePersonaLock(card?.entityId ?? null)
  const action = useAction()
  if (card === null) return null
  const persona = state.persona === card.entityId ? null : state.persona
  const locked = persona !== null && lock.persona?.entityId === persona
  return (
    <PickerLockRow
      checked={locked}
      disabled={persona === null || !lock.ready || action.pending}
      onCheckedChange={(on) =>
        void action
          .run(
            (client) => client("SetPersonaLock", { entityId: card.entityId, persona: on ? persona : null }),
            [LOCK_KEY]
          )
          .then((result) => {
            if (!result.ok)
              showToast({ title: "Couldn’t change who you play with them", description: result.error.message })
          })
      }
      hint={persona === null ? `Choose a persona before locking it to ${card.name}.` : lockHint(card.name)}
    >
      Always play as this with {card.name}
    </PickerLockRow>
  )
}

/** In a character's tab: who new chats with them start as, and clearing it. */
function CharacterPersonaLock({ card, persona: played }: { card: CastCard; persona: boolean }) {
  const lock = usePersonaLock(played ? null : card.entityId)
  const action = useAction()
  if (played || lock.persona === null) return null
  return (
    <div data-persona-lock="" className="-mx-2 flex min-w-0 flex-wrap items-center gap-x-1 text-sm">
      <span className="min-w-0 px-2 [overflow-wrap:anywhere] text-muted">
        You play <span className="font-medium text-text">{lock.persona.name}</span> with {card.name}
      </span>
      <Button
        variant="ghost"
        className="h-8! px-2!"
        disabled={action.pending}
        hint={`New chats with ${card.name} start with your default persona again. Chats already started keep theirs.`}
        onClick={() =>
          void action
            .run((client) => client("SetPersonaLock", { entityId: card.entityId, persona: null }), [LOCK_KEY])
            .then((result) => {
              if (!result.ok)
                showToast({ title: "Couldn’t clear who you play with them", description: result.error.message })
            })
        }
      >
        Clear
      </Button>
    </div>
  )
}

export const registerPersonaLock = () => {
  pendingPersonaPickerRows.register({ id: "characters.persona-lock", order: 10, component: PendingPersonaLock })
  chatCharacterRows.register({ id: "characters.persona-lock", order: 10, component: CharacterPersonaLock })
}
