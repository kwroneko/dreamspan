// Executed only inside a terminable worker; never run imported patterns on the UI thread.
import type { RegexScript } from "@dreamspan/shared/docs/preset.ts"
import { run } from "@dreamspan/shared/regexReplace.ts"
import { expandForDisplay, type DisplayNames } from "./macros.ts"
import { parse } from "@dreamspan/shared/macros/parse.ts"
import type { CardFields } from "@dreamspan/shared/macros/context.ts"
import type { DisplayResult } from "./displayPipeline.ts"

export interface RegexJob {
  readonly text: string
  readonly scripts: ReadonlyArray<RegexScript>
  readonly placement: number
  readonly depth: number | null
  readonly names: DisplayNames
  readonly card: CardFields
}
export const runDisplayRegex = (job: RegexJob): DisplayResult => {
  const original = job.text
  const issues: string[] = []
  if (original.length > 200_000)
    return { text: original, issues: ["Display regex skipped: message exceeds 200,000 characters."] }
  const usable = job.scripts.filter(
    (s) => !s.disabled && s.find_regex !== "" && s.markdown_only && s.placement.includes(job.placement)
  )
  if (usable.length > 100) issues.push("Only the first 100 display regex scripts run.")
  let text = original
  const output = { left: 1_000_000 }
  for (const script of usable.slice(0, 100)) {
    const min = script.min_depth !== null && script.min_depth >= -1 ? script.min_depth : null
    const max = script.max_depth !== null && script.max_depth >= 0 ? script.max_depth : null
    if (job.depth === null && (min !== null || max !== null)) {
      issues.push(`Display regex “${script.name.slice(0, 100)}” is waiting for this message's depth.`)
      continue
    }
    if (job.depth !== null && ((min !== null && job.depth < min) || (max !== null && job.depth > max))) continue
    try {
      const expand = (s: string) => {
        const result = expandForDisplay(s, "template", job.names, job.card)
        if (result.issue) throw new Error(result.issue)
        return result.text
      }
      let source = script.find_regex
      if (source.length > 2_000 || script.replace_string.length > 200_000 || script.trim_strings.length > 100)
        throw new Error("size limit")
      if (script.substitute_regex === "raw") source = expand(source)
      if (script.substitute_regex === "escaped") {
        let resolved = ""
        let from = 0
        for (const node of parse(source)) {
          // Nested arguments are expanded as one macro before escaping its result.
          if (node.kind === "macro" && node.flags.includes("/")) throw new Error("scoped pattern macros")
          const value = expand(source.slice(node.start, node.end)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          resolved += source.slice(from, node.start) + value
          if (resolved.length > 2_000) throw new Error("pattern size limit")
          from = node.end
        }
        source = resolved + source.slice(from)
      }
      if (source.length > 2_000) throw new Error("pattern size limit")
      const literal = /^\/(.*)\/([a-z]*)$/s.exec(source)
      const regex = literal ? new RegExp(literal[1]!, literal[2]) : new RegExp(source)
      const next = run(regex, expand(script.replace_string), script.trim_strings.map(expand), text, output)
      if (next.length > 200_000) throw new Error("message size limit")
      text = next
    } catch {
      issues.push(
        `Display regex “${script.name.slice(0, 100)}” skipped: invalid pattern, unsupported scoped pattern macro, or macro/size limit.`
      )
    }
  }
  return { text, issues }
}
