// The app's default Agent instructions (presetOrder.ts `agentInstructionsPrompt`): what a story
// reply that uses tools is told with the end of the request when its preset's prompt is empty or
// missing. Shared so the preset editor shows the same text the server sends.

/** How the reply is given (DESIGN §7.2). */
export type ReplyContract = "final_text" | "send_message" | "both" | "several"

/** The default text, given the tools actually offered and how the reply is taken. */
export const agentInstructions = (
  offered: ReadonlyArray<string>,
  contract: ReplyContract,
  /** Whether the reply may pass with no_reply; by default, wherever the send tool alone is the way. */
  options?: { readonly noReply?: boolean }
) =>
  [
    offered.length > 0
      ? "Before you write, you can use your tools to check earlier events, summaries, lore and notes, and to keep notes. Use them only when they help."
      : "",
    contract === "final_text"
      ? "When you're ready, write the reply as your answer, and nothing else."
      : contract === "send_message"
        ? (options?.noReply ?? true)
          ? "When you're ready, send the reply with send_message. If your character says nothing this turn, call no_reply instead."
          : "When you're ready, send the reply with send_message."
        : "When you're ready, send the reply with send_message, or write it as your answer."
  ]
    .filter(Boolean)
    .join(" ")

/**
 * The preset prompt "When the reply wasn't sent" (spec/REPLY-CONTRACT.md §3.3): what the app tells
 * the model when a turn under the send tool ends in plain text. Never in the prompt order; a
 * preset without it, or with it empty, sends the default (the Agent instructions' fallback rule).
 */
export const SEND_NUDGE_PROMPT = {
  identifier: "sendNudge",
  label: "When the reply wasn't sent",
  hint: "Sent when a reply that uses tools ends in plain text instead of sending it. Leave it empty for the default."
} as const

/** reference-harness's `not_sent` wording, with its no_reply line where the reply may pass. */
export const sendNudgeText = (noReply: boolean) =>
  noReply
    ? "Your turn ended without sending a message. You must end every turn by either:\n- Calling send_message with your reply, OR\n- Calling no_reply if you have nothing to say.\n\nText you write outside of send_message is not visible to users."
    : "Your turn ended without sending a message. You must end every turn by calling send_message with your reply.\n\nText you write outside of send_message is not visible to users."

/** The preset's own nudge text, or null when it has none or it's empty: the default is sent then. */
export const ownSendNudge = (prompts: ReadonlyArray<{ readonly identifier: string; readonly content: string }>) => {
  const own = prompts.find((p) => p.identifier === SEND_NUDGE_PROMPT.identifier)?.content ?? ""
  return own.trim() === "" ? null : own
}

/** How many times one run is asked to send before its reply fails (reference-harness's `forced_completion_retries`). */
export const SEND_NUDGES = 3
