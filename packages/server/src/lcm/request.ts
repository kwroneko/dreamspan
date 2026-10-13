import type { ContextSnapshot } from "../assembler/types.ts"

export const summaryTail = (snapshot: ContextSnapshot): ContextSnapshot => {
  const job = snapshot.summaryJob!
  const request = snapshot.request
  return {
    ...snapshot,
    request: {
      ...request,
      prefill: null,
      messages: [
        ...request.messages,
        {
          role:
            snapshot.inputs.model?.mapping?.midChatSystem === true ||
            (snapshot.inputs.model?.mapping?.midChatSystem === undefined &&
              snapshot.inputs.model?.api === "openai-completions")
              ? "system"
              : "user",
          content: job.tail
        }
      ],
      breakpoints: request.breakpoints.filter((b) => b.reason !== "history")
    }
  }
}
