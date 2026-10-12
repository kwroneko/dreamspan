// A preset's prompt-only regex scripts (ARCHITECTURE §9), as ST 1.19 runs them on the chat
// when it builds a prompt (extensions/regex/engine.js: getRegexedString, runRegexScript).
// They run only once the user approved the preset's scripts (`regex_approved`).
//
// A script's pattern comes from a file, so it must never stall a thread (catastrophic
// backtracking: `(a+)+$` takes exponential time on some inputs). V8 can switch a regex that
// backtracks too much to its linear-time engine; that's turned on here, for the whole
// process. The linear engine can't run backreferences or lookaheads, so a pattern with
// either is refused, and reported, instead of run.
import { setFlagsFromString } from "node:v8"
import type { RegexScript } from "@rp/shared/docs/preset.ts"

setFlagsFromString("--enable-experimental-regexp-engine-on-excessive-backtracks")

/** ST's placements: what a script applies to. */
export const PLACEMENT = { userInput: 1, aiOutput: 2 } as const

/** Backreferences and lookarounds, which keep V8 from falling back to linear time. */
const UNBOUNDED = /\\[1-9]|\\k<|\(\?<?[=!]/

/** ST's regexFromString: `/pattern/flags`, or the whole text as a pattern. Null when it isn't one. */
export const compile = (source: string): RegExp | "unsafe" | null => {
  const m = /(\/?)(.+)\1([a-z]*)/i.exec(source)
  if (!m) return null
  const [pattern, flags] = m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3]) ? [source, ""] : [m[2]!, m[3] ?? ""]
  if (UNBOUNDED.test(pattern)) return "unsafe"
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

/** Whether ST runs a prompt-only script on a message of this placement at this depth. */
export const appliesAt = (script: RegexScript, placement: number, depth: number) =>
  !script.disabled &&
  script.prompt_only &&
  script.placement.includes(placement) &&
  (script.min_depth === null || script.min_depth < -1 || depth >= script.min_depth) &&
  (script.max_depth === null || script.max_depth < 0 || depth <= script.max_depth)

/**
 * ST's runRegexScript, with the replacement already expanded: `{{match}}` and `$n` or `$<name>`
 * become the match and its groups, with the trim strings removed from each.
 */
export const run = (regex: RegExp, replacement: string, trimStrings: ReadonlyArray<string>, text: string) => {
  regex.lastIndex = 0
  const template = replacement.replace(/{{match}}/gi, "$0")
  return text.replace(regex, (...args: Array<unknown>) => {
    const groups = typeof args.at(-1) === "object" ? (args.at(-1) as Record<string, string> | undefined) : undefined
    return template.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num: string | undefined, name: string | undefined) => {
      const value = num ? args[Number(num)] : name ? groups?.[name] : undefined
      if (typeof value !== "string" || !value) return ""
      return trimStrings.reduce((s, trim) => s.replaceAll(trim, ""), value)
    })
  })
}
