// The tail line that tells a workshop's assistant what the user took back since its last reply
// (spec/WORKSHOP-CARDS.md §8.2): "The user reverted your change to Mara Quill (Description,
// Scenario)." Said once, on the next turn: the assistant's transcript stays as it was (causal
// order) and the revision history has the rest. A `turnNotes` entry, so it can be replaced.
import { unitPath } from "@dreamspan/shared/changeReversal.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { EntityKind } from "@dreamspan/shared/library.ts"
import { fieldLabel } from "@dreamspan/shared/libraryText.ts"
import { Effect } from "effect"
import type { Reader } from "../db/Database.ts"
import type { TurnNote } from "./turnNotes.ts"

const listed = (names: ReadonlyArray<string>) => [...new Set(names)].join(", ")

export const reversalNote = (reader: Reader["Service"]): TurnNote => ({
  id: "workshop.reversals",
  line: ({ userId, chatId }) =>
    Effect.gen(function* () {
      const since = yield* reader.ChatReversalsSince({ userId: userId as UserId, chatId })
      const lines = [
        ...since.reversals.map((r) => {
          const fields = listed(r.fields.map((f) => fieldLabel(r.kind as EntityKind, {}, unitPath(f))))
          const what = r.targetKind === "file" ? `the card file ${r.label}` : r.label
          return r.action === "revert"
            ? `The user reverted your change to ${what} (${fields}).`
            : `The user put back your change to ${what} (${fields}).`
        }),
        ...since.binned.map(({ name }) => `The user undid ${name} (in the bin).`)
      ]
      return lines.length === 0
        ? null
        : {
            text: lines.join("\n"),
            events: [...since.reversals.map((r) => r.id), ...since.binned.map((b) => b.id)]
          }
    }).pipe(Effect.orElseSucceed(() => null))
})
