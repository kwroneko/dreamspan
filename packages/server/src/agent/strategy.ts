// The `agent` reply strategy (spec/AGENTIC.md §2): what an agentic mode runs instead of `reply`.
import { Stream } from "effect"
import { GenerationFailed } from "../chat/Generator.ts"
import type { ReplyStrategy } from "../chat/replyStrategy.ts"
import { runAgent } from "./session.ts"

export const agentReplyStrategy: ReplyStrategy = {
  id: "agent",
  run: (input) =>
    input.agent
      ? runAgent(input, input.agent)
      : Stream.fail(new GenerationFailed({ class: "unavailable", message: "This reply mode needs an agent turn." }))
}
