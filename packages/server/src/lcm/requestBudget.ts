import { Effect } from "effect"
import { tokensOf } from "../assembler/st.ts"
import { AssemblyFailed, type ContextSnapshot } from "../assembler/types.ts"

/** Fixed context admission after registered shaping, shared by fresh jobs and rebuilds. */
export const fitSummaryOutput = (snapshot: ContextSnapshot) => {
  const available = Math.floor(
    (snapshot.inputs.model?.context ?? Infinity) - snapshot.request.messages.reduce((n, m) => n + tokensOf(m), 0)
  )
  if (available < 1)
    return Effect.fail(
      new AssemblyFailed({
        reason: "budget",
        message: "The pinned summary prefix and chunk exceed the model context."
      })
    )
  return Effect.succeed({
    ...snapshot,
    request: {
      ...snapshot.request,
      samplers: { ...snapshot.request.samplers, max_tokens: Math.min(snapshot.request.samplers.max_tokens, available) }
    }
  })
}
