// Custom transcript messages are shared by the live loop and the pure resume/step helpers.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Message } from "@earendil-works/pi-ai"
import { compactedTranscript, type RunSummary } from "./compaction.ts"

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    rpCompaction: RunSummary
    /** Stands for the frozen assembled request: everything the model is sent before its own turns. */
    rpRequest: {
      readonly role: "rpRequest"
      readonly timestamp: number
      /**
       * The run gives its reply with the send tool alone (spec/REPLY-CONTRACT.md §3.2): no plain
       * turn is the message, so the steps show them all. Never sent.
       */
      readonly contract?: "send_message"
    }
    rpUser: {
      readonly role: "rpUser"
      readonly message: import("../assembler/types.ts").RequestMessage
      readonly timestamp: number
    }
    /**
     * A message the app adds (the turn cap's "write now", a nudge to send the reply), sent as the
     * user's and labelled as the app's. `nudge`: the run's nth ask to send (spec/REPLY-CONTRACT.md
     * §3.3), counted from the transcript so a resumed run goes on with the count.
     */
    rpApp: {
      readonly role: "rpApp"
      readonly content: string
      readonly timestamp: number
      readonly nudge?: number
      /**
       * Answers to this nudge Resume cut and wrote again (each a plain turn the model wrote), so
       * the failure counts every time it wrote text (§3.4).
       */
      readonly answersCut?: number
      /**
       * A background subagent's report (spec/SUBAGENTS.md §3.2): the call that started it, so a
       * resumed run knows which reports it still waits for.
       */
      readonly report?: { readonly callId: string; readonly handle: string }
      /** A background subagent's progress note (§4), by its handle. */
      readonly progress?: string
      /** A message the parent sent this subagent (`message_agent`, §4). */
      readonly fromParent?: true
    }
    /**
     * The text before it became a message of its own (contract `several`): the run's model ended
     * its turn while background subagents still ran, and the run waited for their reports
     * (spec/SUBAGENTS.md §3.2). Never sent; it marks the message's end for the steps and Resume.
     */
    rpPosted: {
      readonly role: "rpPosted"
      readonly versionId: string
      readonly timestamp: number
    }
  }
}

/** The messages the model sees after the frozen request: its turns, tool results and the app's notes. */
export const liveSuffix = (messages: ReadonlyArray<AgentMessage | Message>): Array<Message> => {
  const start = messages.findIndex((m) => m.role === "rpRequest")
  return compactedTranscript(messages as ReadonlyArray<AgentMessage>)
    .slice(start < 0 ? 0 : 1)
    .flatMap((m): Array<Message> => {
      if (m.role === "rpUser")
        return [
          {
            role: "user",
            content: m.message.content + (m.message.images?.length ? " [image]" : ""),
            timestamp: m.timestamp
          }
        ]
      if (m.role === "rpApp") return [{ role: "user", content: m.content, timestamp: m.timestamp }]
      if (m.role === "assistant" || m.role === "toolResult" || m.role === "user") return [m]
      return []
    })
}

/** How many times this run has been asked to send its reply: the nudges in its transcript. */
export const nudgesIn = (messages: ReadonlyArray<AgentMessage>) =>
  messages.filter((m) => m.role === "rpApp" && typeof (m as { nudge?: unknown }).nudge === "number").length

/** The plain turns that answered a nudge and were cut by a Resume (`answersCut`). */
export const cutAnswersIn = (messages: ReadonlyArray<AgentMessage>) =>
  messages.reduce((n, m) => n + (isNudge(m) ? ((m as { answersCut?: number }).answersCut ?? 0) : 0), 0)

/** The transcript with its frozen request marked as the send tool's alone (`rpRequest.contract`). */
export const sendOnlyTranscript = (messages: ReadonlyArray<AgentMessage>): Array<AgentMessage> => {
  const at = messages.findIndex((m) => m.role === "rpRequest")
  return messages.map((m, i) =>
    i === at ? { ...(m as AgentMessage & { role: "rpRequest" }), contract: "send_message" } : m
  )
}

/** Whether `message` is one of the app's asks to send the reply. */
export const isNudge = (message: AgentMessage | undefined) =>
  message?.role === "rpApp" && typeof (message as { nudge?: unknown }).nudge === "number"
