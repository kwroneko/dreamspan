// Text and framing from the final request. Tools and multimodal requests are deliberately
// ineligible: their extra input must not be learned as a text-token correction.
import { Predicate } from "effect"
export const payloadText = (payload: Readonly<Record<string, unknown>>) => {
  if (["tools", "tool_choice", "response_format"].some((key) => payload[key] != null)) return null
  const texts: Array<string> = []
  let framing = 0
  let eligible = true
  const visit = (value: unknown, key: string) => {
    if (typeof value === "string") {
      if (["text", "content", "system", "instructions", "name"].includes(key)) texts.push(value)
      return
    }
    if (Array.isArray(value)) {
      if (["messages", "input", "contents"].includes(key)) framing += value.length * 3
      for (const item of value) visit(item, "")
    } else if (Predicate.isObject(value)) {
      if (value["type"] && !["text", "input_text", "output_text", "message"].includes(String(value["type"])))
        eligible = false
      if (value["functionCall"] || value["functionResponse"] || value["inlineData"]) eligible = false
      for (const [k, v] of Object.entries(value)) visit(v, k)
    }
  }
  for (const key of ["messages", "system", "input", "instructions", "contents"]) visit(payload[key], key)
  return eligible && texts.length ? { texts, framing } : null
}
