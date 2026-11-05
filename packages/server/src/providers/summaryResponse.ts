import type { AssistantMessage } from "@earendil-works/pi-ai"

/** Only response content belongs in the capture; provider signatures and metadata stay private. */
export const summaryResponse = (message: AssistantMessage, scrub: (text: string) => string) => {
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") return scrub(value)
    if (Array.isArray(value)) return value.map(clean)
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [scrub(key), clean(entry)]))
    return value
  }
  return JSON.stringify(
    clean({
      content: message.content.map((part) =>
        part.type === "text"
          ? { type: part.type, text: part.text }
          : part.type === "thinking"
            ? { type: part.type, thinking: part.thinking }
            : { type: part.type, id: part.id, name: part.name, arguments: part.arguments }
      ),
      stopReason: message.stopReason,
      error: message.errorMessage ?? null
    })
  )
}
