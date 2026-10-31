// Continue without a prefill (owner, 2026-10-31): the model wrote only what follows the reply,
// which was its own last message, so the new text starts with no space of its own. The
// registered reply parser that puts the preset's `continue_postfix` (ST's, a space by default)
// before it, as ST appends it to a continued message that doesn't end in a space. It runs
// before the reply sections parser, so a reply cut off inside a section goes on inside it.
import type { ReplyParser } from "./replySections.ts"

export const continueJoinParser: ReplyParser = {
  id: "continue-join",
  create: ({ generation }) => {
    const join = generation.request.continuation?.join
    if (!join) return null
    let first = true
    return {
      push: (chunk) => {
        if (!first || typeof chunk !== "string" || chunk === "") return [chunk]
        first = false
        return [/^\s/.test(chunk) ? chunk : join + chunk]
      },
      end: () => []
    }
  }
}
