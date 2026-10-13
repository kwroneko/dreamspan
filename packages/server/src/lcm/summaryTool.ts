import { Type, type Tool } from "@earendil-works/pi-ai"

export const summaryTool: Tool = {
  name: "summary_tool",
  description:
    "Create, view, revise and finalize the summary document. Use create with file_text and finalize:true to finish in one call.",
  parameters: Type.Object({
    command: Type.Union(["create", "view", "str_replace", "insert", "finalize"].map((c) => Type.Literal(c))),
    file_text: Type.Optional(Type.String()),
    old_str: Type.Optional(Type.String()),
    new_str: Type.Optional(Type.String()),
    insert_line: Type.Optional(Type.Integer({ minimum: 0 })),
    view_range: Type.Optional(Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 })),
    finalize: Type.Optional(Type.Boolean())
  })
}
export const summaryDraft = (limit: number) => {
  let content: string | null = null
  return {
    content: () => content,
    execute: (args: Record<string, unknown>) => {
      const before = content
      try {
        const str = (key: string) => {
          const value = args[key]
          if (typeof value !== "string") throw new Error(`${key} must be text`)
          return value
        }
        switch (args.command) {
          case "create":
            if (content !== null) throw new Error("Draft already exists; use str_replace or insert.")
            content = str("file_text")
            break
          case "str_replace": {
            if (content === null) throw new Error("Create a draft first.")
            const old = str("old_str"),
              at = content.indexOf(old)
            if (!old || at < 0 || content.indexOf(old, at + old.length) >= 0)
              throw new Error("old_str must match exactly once.")
            content =
              content.slice(0, at) + (args.new_str === undefined ? "" : str("new_str")) + content.slice(at + old.length)
            break
          }
          case "insert": {
            if (content === null) throw new Error("Create a draft first.")
            const lines = content.split("\n"),
              at = args.insert_line
            if (typeof at !== "number" || !Number.isInteger(at) || at < 0 || at > lines.length)
              throw new Error("insert_line is outside the draft.")
            lines.splice(at, 0, str("new_str"))
            content = lines.join("\n")
            break
          }
          case "view": {
            const lines = (content ?? "").split("\n"),
              range = args.view_range
            const start = Array.isArray(range) ? range[0] : 1,
              end = Array.isArray(range) ? range[1] : lines.length
            if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || (end !== -1 && end < start))
              throw new Error("Invalid view_range.")
            if (args.finalize !== true)
              return {
                text: lines
                  .slice(start - 1, end === -1 ? undefined : end)
                  .map((line, i) => `${start + i}: ${line}`)
                  .join("\n"),
                done: false,
                isError: false
              }
            break
          }
          case "finalize":
            break
          default:
            throw new Error("Unknown summary command.")
        }
        if (!content?.trim()) throw new Error("The summary must not be empty.")
        if (Math.ceil(content.length / 4) > limit) throw new Error(`The summary exceeds ${limit} tokens; shorten it.`)
        return {
          text: `Summary saved (${Math.ceil(content.length / 4)} tokens).`,
          done: args.command === "finalize" || args.finalize === true,
          isError: false
        }
      } catch (error) {
        content = before
        return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, done: false, isError: true }
      }
    }
  }
}

export const clipSummary = (text: string, target: number) => {
  const clipped = text.slice(0, Math.floor(target * 4)).trim()
  const end = [...clipped.matchAll(/[.!?。！？](?:\s|$)/gu)].at(-1)
  return end && end.index! > clipped.length / 2 ? clipped.slice(0, end.index! + 1) : clipped
}
