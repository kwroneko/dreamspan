// A preset's prompt-only regex scripts (ARCHITECTURE §9), as ST 1.19 runs them on the chat
// when it builds a prompt (extensions/regex/engine.js: getRegexedString, runRegexScript).
// They run only once the user approved the preset's scripts (`regex_approved`).
//
// A script's pattern comes from a file, so it must never stall a thread: `(a+)+$` takes
// exponential time on some inputs with a backtracking engine. So every script runs on V8's
// linear-time engine (the `l` flag; turned on here, for the whole process). That engine
// takes no `i` or `u` flag, so a case-insensitive pattern is rewritten with both cases of
// each ASCII letter, and `u` is dropped when the pattern uses nothing only it allows. What
// it can't run at all (backreferences, lookarounds) is refused, and reported, never run.
import { setFlagsFromString } from "node:v8"
import type { RegexScript } from "@rp/shared/docs/preset.ts"

setFlagsFromString("--enable-experimental-regexp-engine")

/** ST's placements: what a script applies to. */
export const PLACEMENT = { userInput: 1, aiOutput: 2 } as const

const isLetter = (c: string) => /^[a-zA-Z]$/.test(c)
const swap = (c: string) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())

/**
 * The pattern matching the same text in either case, for ASCII letters: `a` (or `\\x61`)
 * becomes `[aA]`, and a class gets the other case of its letters and letter ranges. Other
 * escapes, group names and quantifiers are kept as they are.
 */
export const caseless = (pattern: string) => {
  let out = ""
  let i = 0
  /** One character of the pattern, or one escape with what belongs to it, and the letter it stands for. */
  const atom = () => {
    if (pattern[i] !== "\\") return { text: pattern[i++]!, letter: isLetter(pattern[i - 1]!) ? pattern[i - 1]! : null }
    const next = pattern[i + 1] ?? ""
    const length = next === "x" ? 4 : next === "u" ? 6 : next === "c" ? 3 : 2
    const text = pattern.slice(i, i + length)
    i += length
    const code = /^\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4}))$/.exec(text)
    const char = code ? String.fromCharCode(Number.parseInt(code[1] ?? code[2]!, 16)) : ""
    return { text, letter: isLetter(char) ? char : null }
  }
  const sameCase = (a: string, b: string) => (a === a.toLowerCase()) === (b === b.toLowerCase())
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === "(" && pattern.startsWith("(?<", i) && !/^\(\?<[=!]/.test(pattern.slice(i))) {
      const close = pattern.indexOf(">", i)
      out += pattern.slice(i, close + 1)
      i = close + 1
    } else if (c === "[") {
      let item = "["
      const extra: Array<string> = []
      i++
      if (pattern[i] === "^") item += pattern[i++]
      while (i < pattern.length && pattern[i] !== "]") {
        const from = atom()
        if (pattern[i] === "-" && pattern[i + 1] !== undefined && pattern[i + 1] !== "]") {
          i++
          const to = atom()
          item += `${from.text}-${to.text}`
          if (from.letter && to.letter && sameCase(from.letter, to.letter)) {
            extra.push(`${swap(from.letter)}-${swap(to.letter)}`)
          }
          continue
        }
        item += from.text
        if (from.letter) extra.push(swap(from.letter))
      }
      out += `${item}${extra.join("")}]`
      i++
    } else if (c === "{") {
      // A quantifier's bounds, or a literal brace: digits and commas, no letters.
      const bounds = /^\{\d*,?\d*\}/.exec(pattern.slice(i))?.[0]
      out += bounds ?? c
      i += bounds?.length ?? 1
    } else {
      const { text, letter } = atom()
      out += letter ? `[${letter}${swap(letter)}]` : text
    }
  }
  return out
}

/** ST's regexFromString: `/pattern/flags`, or the whole text as a pattern; null when it isn't one. */
export const compile = (source: string): RegExp | "unsafe" | null => {
  const m = /(\/?)(.+)\1([a-z]*)/i.exec(source)
  if (!m) return null
  let [pattern, flags] = m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3]) ? [source, ""] : [m[2]!, m[3] ?? ""]
  try {
    new RegExp(pattern, flags)
  } catch {
    return null
  }
  if (flags.includes("u") && /\\[pP]\{|\\u\{/.test(pattern)) return "unsafe"
  flags = flags.replace("u", "")
  if (flags.includes("i")) {
    pattern = caseless(pattern)
    flags = flags.replace("i", "")
  }
  try {
    return new RegExp(pattern, `${flags}l`)
  } catch {
    return "unsafe"
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
