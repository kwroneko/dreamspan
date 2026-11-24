import { canonicalJson } from "@dreamspan/shared/editing.ts"
import type { PathEntry } from "@dreamspan/shared/chat.ts"
import type { FoldableEvent } from "@dreamspan/shared/state.ts"
import { createHash } from "node:crypto"

/** A bounded stamp of the state read before a decision, including who last changed presence. */
export const decisionStateStamp = (events: ReadonlyArray<FoldableEvent>): string => {
  const hash = createHash("sha256")
  for (const event of events) hash.update(canonicalJson([event.scope, event.data.key, event.data.value])).update("\n")
  return hash.digest("hex")
}

export const PRESENCE_WINDOW_SIZE = 2

/** What the presence check saw at each slot, including in-place amendments. */
export const decisionWindowStamp = (entries: ReadonlyArray<PathEntry>): string =>
  createHash("sha256")
    .update(
      canonicalJson(
        entries.map(({ slotId, contextExcluded, version }) => [
          slotId,
          contextExcluded,
          version.id,
          version.rowVersion,
          version.speakerEntityId
        ])
      )
    )
    .digest("hex")
