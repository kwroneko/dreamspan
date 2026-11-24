// The tail line that tells a workshop's assistant what changed under it (spec/WORKSHOP-CARDS.md
// §4.3): "Changed since you last saw it: Mara Quill (Description, by the user)." An item in view
// (attached on the path, made here, the workshop's own cast) that someone other than this
// workshop changed since its latest reply ended, said once, on the next turn. A revert is told by
// its own line (reversalNote.ts). A `turnNotes` entry, so it can be replaced.
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { EntityKind } from "@dreamspan/shared/library.ts"
import { fieldLabel } from "@dreamspan/shared/libraryText.ts"
import { Effect } from "effect"
import type { Reader } from "../db/Database.ts"
import type { TurnNote } from "./turnNotes.ts"

const byWhom = (origins: ReadonlyArray<string>) => {
  const who = [
    ...new Set(
      origins.map((origin) =>
        origin === "user" ? "the user" : origin === "agent" ? "another chat's assistant" : "an import or a sync"
      )
    )
  ]
  return `by ${who.join(" and ")}`
}

export const changedNote = (reader: Reader["Service"]): TurnNote => ({
  id: "workshop.changed-in-view",
  line: ({ userId, chatId, forkId, leafSlotId, state }) =>
    Effect.gen(function* () {
      const changed = yield* reader.ChangedInViewSince({
        userId: userId as UserId,
        chatId: chatId as ChatId,
        forkId: (forkId ?? null) as ForkId | null,
        leafSlotId: (leafSlotId ?? null) as SlotId | null,
        entities: [...state.participants, ...state.playedByMe]
      })
      if (changed.length === 0) return null
      const items = changed.map((item) => {
        const fields = [...new Set(item.fields.map((field) => fieldLabel(item.kind as EntityKind, {}, [field])))]
        return `${item.name} (${[...fields, byWhom(item.by)].join(", ")})`
      })
      return `Changed since you last saw it: ${items.join("; ")}.`
    }).pipe(Effect.orElseSucceed(() => null))
})
