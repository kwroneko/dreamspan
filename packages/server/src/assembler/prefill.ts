// Provider-specific prerequisites, resolved with the model independently of context budgeting.
import type { ModelInput } from "./types.ts"

export const prefillUnavailable = (
  model: Pick<ModelInput, "kind" | "api" | "key" | "prefill">,
  baseUrl: string | null
): string | undefined => {
  if (model.prefill === "none")
    return `${model.key} isn't set up to take the start of its reply (a prefill). If it can, turn on its Prefill capability (Settings → Connections, or Continue on a reply).`
  if (model.prefill === "tool_schema" && model.api !== "openai-responses" && model.api !== "openai-completions")
    return `${model.key} declares tool-schema prefill, but this provider API has no schema-prefill adapter. Choose an OpenAI Responses or Chat Completions connection.`
  if (
    model.prefill === "assistant" &&
    model.kind === "deepseek" &&
    (baseUrl === null || !/\/beta\/?$/.test(new URL(baseUrl).pathname))
  )
    return `${model.key} needs DeepSeek's /beta endpoint for Continue. Update the Base URL in Settings → Connections; the endpoint has not been changed.`
  return undefined
}

export const REPLY_TOOL = "continue_reply"

/** Like the reference's anchored analysis argument, but constrain the entire reply text. */
export const replyTool = (prefix: string) => ({
  name: REPLY_TOOL,
  description:
    "Continue the reply in text, beginning with the exact existing reply in the text description. Return the complete reply including that prefix and new prose after it.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: prefix, pattern: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` }
    },
    required: ["text"],
    additionalProperties: false
  }
})

/** The same four-characters-per-token estimate as assembly, including the repeated JSON prefix. */
export const schemaPrefillBudget = (prefix: string) => ({
  input:
    Math.ceil(
      JSON.stringify({
        tools: [{ type: "function", function: replyTool(prefix) }],
        tool_choice: { type: "function", function: { name: REPLY_TOOL } },
        parallel_tool_calls: false
      }).length / 4
    ) + 3,
  output: Math.ceil(JSON.stringify({ text: prefix }).length / 4) + 3
})
