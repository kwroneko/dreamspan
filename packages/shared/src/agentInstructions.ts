// The app's default Agent instructions (presetOrder.ts `agentInstructionsPrompt`): what a story
// reply that uses tools is told with the end of the request when its preset's prompt is empty or
// missing. Shared so the preset editor shows the same text the server sends.

/** How the reply is given (DESIGN §7.2). */
export type ReplyContract = "final_text" | "send_message" | "both" | "several"

/** The default text, given the tools actually offered and how the reply is taken. */
export const agentInstructions = (offered: ReadonlyArray<string>, contract: ReplyContract) =>
  [
    offered.length > 0
      ? "Before you write, you can use your tools to check earlier events, summaries, lore and notes, and to keep notes. Use them only when they help."
      : "",
    contract === "final_text"
      ? "When you're ready, write the reply as your answer, and nothing else."
      : contract === "send_message"
        ? "When you're ready, send the reply with send_message."
        : "When you're ready, send the reply with send_message, or write it as your answer."
  ]
    .filter(Boolean)
    .join(" ")
