import { canonicalJson } from "@dreamspan/shared/editing.ts"
import type { FoldableEvent } from "@dreamspan/shared/state.ts"
import { createHash } from "node:crypto"

/** A bounded stamp of the state read before a decision, including who last changed presence. */
export const decisionStateStamp = (events: ReadonlyArray<FoldableEvent>): string => {
  const hash = createHash("sha256")
  for (const event of events) hash.update(canonicalJson([event.scope, event.data.key, event.data.value])).update("\n")
  return hash.digest("hex")
}
