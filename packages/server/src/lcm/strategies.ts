import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai"
import type { ContextSnapshot } from "../assembler/types.ts"
import type { SummaryJob } from "../db/lcmJobs.ts"
import type { Registry } from "../registry.ts"
import { summaryDraft, summaryTool } from "./summaryTool.ts"
import { DIRECT_INSTRUCTION, TOOL_INSTRUCTION } from "./instructions.ts"

export interface SummaryToolFactory {
  readonly id: string
  /** How to use this factory's tool. Omitted: follow the offered tool's definition. */
  readonly instruction?: string
  /** Definition and executor are instantiated together, once per job attempt. */
  readonly create: (input: SummaryExecutionInput) => {
    readonly definition: Tool
    readonly content: () => string | null
    readonly execute: (args: Record<string, unknown>) => { text: string; done: boolean; isError: boolean }
  }
}

export interface SummaryExecutionInput {
  readonly job: SummaryJob
  readonly snapshot: ContextSnapshot
}

export interface SummaryStrategy {
  readonly id: string
  /** Its name in the summary settings' "Written as" picker; absent, the id. The built-ins are named there. */
  readonly label?: string
  /** For the user, on hover in that picker: what it does, in a short sentence. */
  readonly description?: string
  /** Output instructions appended during worker assembly, before budgeting and freezing. */
  readonly instruction?: (tools: SummaryTools) => string
  readonly create: (
    input: SummaryExecutionInput,
    tools: SummaryTools
  ) => {
    readonly tools?: Tool[]
    readonly candidate: () => string
    readonly onText: (delta: string) => void
    readonly beginTurn: () => void
    readonly accept: (reply: AssistantMessage) => {
      readonly done: boolean
      readonly content: string
      readonly appended: Message[]
    }
  }
}

type SummaryTools = Pick<Registry<SummaryToolFactory>, "get" | "list">

export const summaryToolFactory: SummaryToolFactory = {
  id: "summary_tool",
  instruction: TOOL_INSTRUCTION,
  create: ({ job }) => ({ definition: summaryTool, ...summaryDraft(Math.ceil(job.target * 2.5)) })
}

export const directSummary: SummaryStrategy = {
  id: "direct",
  instruction: () => DIRECT_INSTRUCTION,
  create: () => {
    let responseText = ""
    return {
      candidate: () => responseText,
      beginTurn: () => {
        responseText = ""
      },
      onText: (delta) => {
        responseText += delta
      },
      accept: (reply) => ({
        done: true,
        content: reply.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(""),
        appended: []
      })
    }
  }
}

export const toolSummary: SummaryStrategy = {
  id: "tool",
  instruction: (tools) =>
    tools.get("summary_tool")?.instruction ??
    "\nWrite the summary with the provided tool, following its definition; assistant prose is not the summary.",
  create: (input, tools) => {
    const factory = tools.get("summary_tool")
    if (!factory) throw new Error("Summary tool summary_tool is unavailable.")
    const tool = factory.create(input)
    return {
      tools: [tool.definition],
      candidate: () => tool.content() ?? "",
      beginTurn: () => {},
      onText: () => {},
      accept: (reply) => {
        const calls = reply.content.filter((p) => p.type === "toolCall")
        let done = !calls.length
        const appended: Message[] = [reply]
        for (const call of calls) {
          const result =
            call.name === tool.definition.name
              ? tool.execute(call.arguments)
              : { text: `Error: Only ${tool.definition.name} is available.`, done: false, isError: true }
          appended.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: result.text }],
            isError: result.isError,
            timestamp: Date.now()
          })
          done ||= result.done
        }
        return { done, content: tool.content() ?? "", appended }
      }
    }
  }
}
