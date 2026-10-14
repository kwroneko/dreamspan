// Keep the provider's original tool JSON: pi-ai's parsed arguments are repaired
// for streaming previews and cannot prove that a completed response was valid.
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export const captureToolArguments = () => {
  const argumentsById: Record<string, string> = {}
  const chatIds = new Map<number, string>()
  const responseIds = new Map<number, string>()
  const item = (value: unknown, index?: number) => {
    const call = record(value)
    if (call?.type !== "function_call" || typeof call.call_id !== "string") return
    // pi-ai preserves both Responses identifiers in its normalized ToolCall.id.
    const id = `${call.call_id}|${call.id}`
    if (index !== undefined) responseIds.set(index, id)
    if (typeof call.arguments === "string") argumentsById[id] = call.arguments
  }
  return {
    argumentsById,
    observe: (value: unknown) => {
      const event = record(value)
      if (!event) return
      if (Array.isArray(event.choices)) {
        const calls = record(record(event.choices[0])?.delta)?.tool_calls
        if (Array.isArray(calls)) {
          for (const value of calls) {
            const call = record(value)
            if (typeof call?.index !== "number") continue
            if (typeof call.id === "string") chatIds.set(call.index, call.id)
            const id = chatIds.get(call.index)
            const delta = record(call.function)?.arguments
            if (id !== undefined && typeof delta === "string") argumentsById[id] = (argumentsById[id] ?? "") + delta
          }
        }
      }
      if (event.type === "response.output_item.added" || event.type === "response.output_item.done")
        item(event.item, typeof event.output_index === "number" ? event.output_index : undefined)
      if (typeof event.output_index === "number") {
        const id = responseIds.get(event.output_index)
        if (id !== undefined) {
          if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string")
            argumentsById[id] = (argumentsById[id] ?? "") + event.delta
          if (event.type === "response.function_call_arguments.done" && typeof event.arguments === "string")
            argumentsById[id] = event.arguments
        }
      }
      const output = record(event.response)?.output
      if (Array.isArray(output)) for (const call of output) item(call)
    }
  }
}
