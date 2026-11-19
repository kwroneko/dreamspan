// An agent run's transcript after its request, as the run inspector lists it (agentReads.ts, subagents.ts).
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { TranscriptEntry, TurnPart } from "@dreamspan/shared/agent.ts"
import type { PlacedStep } from "../agent/steps.ts"

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((p: { type?: string; text?: string }) => (p.type === "text" && p.text !== undefined ? [p.text] : []))
          .join("")
      : ""

/**
 * What the loop added after the frozen request, as the model saw it; the request's own marker left
 * out. `steps`: each step's place (`placedSteps`), so a part or result says which step it is
 * (none for a cut span, whose steps aren't the version's). `requests`: the requests before these.
 */
export const transcriptEntries = (
  messages: ReadonlyArray<AgentMessage>,
  tools: number,
  turnCap: number,
  steps: ReadonlyArray<PlacedStep> = [],
  requests = 0
): Array<TranscriptEntry> => {
  let request = requests
  const stepAt = new Map(steps.map((s, i) => [`${s.message}:${s.part}`, i]))
  const callStep = new Map(
    steps.flatMap((s, i) => (s.step.kind === "tool" ? [[`${s.message}:${s.step.id}`, i] as const] : []))
  )
  let assistantAt = -1
  const index = (step: number | undefined) => (step === undefined ? {} : { step })
  return messages.flatMap((m, at): Array<TranscriptEntry> => {
    if (m.role === "assistant") {
      assistantAt = at
      return [
        {
          role: "assistant",
          parts: [
            ...m.content.flatMap((p, part): Array<TurnPart> => {
              const step = index(stepAt.get(`${at}:${part}`))
              return p.type === "thinking"
                ? [{ type: "thinking", text: p.thinking, ...step }]
                : p.type === "text"
                  ? [{ type: "text", text: p.text, ...step }]
                  : p.type === "toolCall"
                    ? [{ type: "toolCall", id: p.id, name: p.name, args: p.arguments, ...step }]
                    : []
            }),
            // A turn that wrote nothing is a step of its own (steps.ts), with no part to show it by.
            ...(stepAt.has(`${at}:-1`) ? [{ type: "text" as const, text: "", step: stepAt.get(`${at}:-1`)! }] : [])
          ],
          stopReason: m.stopReason,
          toolsOffered: ++request < turnCap && tools > 0,
          ...(m.errorMessage ? { error: m.errorMessage } : {})
        }
      ]
    }
    if (m.role === "toolResult")
      return [
        {
          role: "toolResult",
          toolCallId: m.toolCallId,
          tool: m.toolName,
          text: textOf(m.content),
          isError: m.isError,
          // What the model was sent, when it was a page of the whole result (built `sentText`).
          ...(typeof (m.details as { sentText?: unknown } | null)?.sentText === "string"
            ? { sent: (m.details as { sentText: string }).sentText }
            : {}),
          ...index(callStep.get(`${assistantAt}:${m.toolCallId}`))
        }
      ]
    if (m.role === "rpCompaction")
      return [
        {
          role: "app",
          text: `Summarized transcript ${m.from}–${m.through - 1}${m.model ? ` with ${m.model}` : " (model not recorded)"}. Original steps remain available.\n${m.content}`
        }
      ]
    if (m.role === "rpUser") {
      request = 0
      return [{ role: "app", text: m.message.content + (m.message.images?.length ? " [image]" : "") }]
    }
    const other = m as { readonly role: string; readonly content?: unknown }
    if (other.role === "rpApp" || other.role === "user") {
      const nudge = (m as { readonly nudge?: unknown }).nudge
      return [{ role: "app", text: textOf(other.content), ...(typeof nudge === "number" ? { nudge } : {}) }]
    }
    return []
  })
}
