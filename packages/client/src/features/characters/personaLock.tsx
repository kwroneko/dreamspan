// The persona locked to a character (DESIGN §2.2, owner 2026-11-18: "an explicit lock
// per-character"): new single chats with them start as it instead of the account default.
// Set from a new single chat's persona pickers, the composer's and the Cast tab's (Always play
// as <Persona> with <Name>, a row at the top); shown, and cleared, in the character's own
// tab in the chat panel. A lock never changes a chat that has started. Both parts are
// registered slot entries, so a plugin can replace or drop either. A lock is account data, so
// another browser tab follows a change at once (the `dreamspan.personaLock` channel) and on focus, as
// display preferences and external media do (ARCHITECTURE §5 "Client state").
import type { CastCard, EntityId } from "@dreamspan/shared/chat.ts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { useEffect, useSyncExternalStore } from "react"
import { useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
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

/** Same-origin tabs carry the signal only, never the lock itself. */
const channel =
  typeof window === "undefined" || typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("dreamspan.personaLock")

/** The persona locked to a character, once read (null: none, or not read yet); read again when another tab changes a lock. */
const usePersonaLock = (entityId: EntityId | null) => {
  const atom = lockAtom(entityId ?? "")
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  useEffect(() => {
    if (entityId === null) return
    channel?.addEventListener("message", refresh)
    window.addEventListener("focus", refresh)
    return () => {
      channel?.removeEventListener("message", refresh)
      window.removeEventListener("focus", refresh)
    }
  }, [entityId, refresh])
  return AsyncResult.isSuccess(result) ? { ready: true, persona: result.value } : { ready: false, persona: null }
}

/** Sets or clears a lock, then tells the other tabs. */
const writeLock = (action: ReturnType<typeof useAction>, entityId: EntityId, persona: EntityId | null) =>
  action
    .run((client) => client("SetPersonaLock", { entityId, persona }), [LOCK_KEY])
    .then((result) => {
      if (result.ok) channel?.postMessage("changed")
      return result
    })

const lockHint = (name: string) => `New chats with ${name} start with this persona. Chats already started keep theirs.`

/**
 * At the top of a new single chat's persona pickers (the composer's and the Cast tab's), under
 * the search: lock the persona picked to its character. A row of the list's own inset, not a
 * settings switch; none while no persona is picked.
 */
function PendingPersonaLock({ pending }: { pending: PendingChat }) {
  const state = useSyncExternalStore(pending.subscribe, pending.snapshot)
  // The chat's one character now: none once another joins in the Cast tab.
  const card = pending.lockCard(state)
  const lock = usePersonaLock(card?.entityId ?? null)
  const action = useAction()
  const persona = card === null || state.persona === card.entityId ? null : pending.playing(state)
  if (card === null || persona === null) return null
  const locked = lock.persona?.entityId === persona.entityId
  return (
    <div className="mx-2 flex min-h-9 shrink-0 items-center rounded-md px-2 py-2 hover:bg-surface-raised">
      <Checkbox
        checked={locked}
        disabled={!lock.ready || action.pending}
        hintInline={false}
        onCheckedChange={(on) =>
          void writeLock(action, card.entityId, on ? persona.entityId : null).then((result) => {
            if (!result.ok)
              showToast({ title: "Couldn’t change who you play with them", description: result.error.message })
          })
        }
        hint={lockHint(card.name)}
      >
        {/* One line, as the list's rows: long names end in an ellipsis rather than wrap. */}
        <span data-layout-name className="block truncate">
          Always play as {persona.name} with {card.name}
        </span>
      </Checkbox>
    </div>
  )
}

/**
 * In a character's tab: who new chats with them start as, and clearing it. Only in a chat with
 * that character alone: in a group the lock doesn't apply, and the chat may use another persona.
 */
function CharacterPersonaLock({
  card,
  persona: played,
  single
}: {
  card: CastCard
  persona: boolean
  single: boolean
}) {
  const shown = single && !played
  const lock = usePersonaLock(shown ? card.entityId : null)
  const action = useAction()
  if (!shown || lock.persona === null) return null
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
          void writeLock(action, card.entityId, null).then((result) => {
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
