// Provider-specific prerequisites, resolved with the model independently of context budgeting.
import { estimateTokens } from "./st.ts"
import type { ModelInput } from "./types.ts"

/**
 * DeepSeek's own API takes a prefix (prefill) only at its /beta address. Another host is a router
 * or compatible server in front of it that decides where a `prefix: true` request goes
 * (liveapi2), so only DeepSeek's host is held to the /beta address.
 */
const deepseekNeedsBeta = (baseUrl: string | null) => {
  const url = new URL(baseUrl ?? "https://api.deepseek.com")
  return url.hostname === "api.deepseek.com" && !/\/beta\/?$/.test(url.pathname)
}

export const prefillUnavailable = (
  model: Pick<ModelInput, "kind" | "api" | "key" | "prefill">,
  baseUrl: string | null
): string | undefined => {
  if (model.prefill === "none")
    return `${model.key} isn't set up to take the start of its reply (a prefill). If it can, turn on its Prefill capability in Settings → Connections.`
  if (model.prefill === "tool_schema" && model.api !== "openai-responses" && model.api !== "openai-completions")
    return `${model.key} declares tool-schema prefill, but this provider API has no schema-prefill adapter. Choose an OpenAI Responses or Chat Completions connection.`
  if (model.prefill === "assistant" && model.kind === "deepseek" && deepseekNeedsBeta(baseUrl))
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

/** Tokenize the schema input; its output reserve must match the wire adapter's allocation. */
export const schemaPrefillBudget = (prefix: string, countText = estimateTokens) => ({
  input:
    countText(
      JSON.stringify({
        tools: [{ type: "function", function: replyTool(prefix) }],
        tool_choice: { type: "function", function: { name: REPLY_TOOL } },
        parallel_tool_calls: false
      })
    ) + 3,
  output: estimateTokens(JSON.stringify({ text: prefix })) + 3
})
