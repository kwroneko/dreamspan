import { run, OutputLimit } from "@rp/shared/regexReplace.ts"
export { run } from "@rp/shared/regexReplace.ts"
// A preset's prompt-only regex scripts, as ST 1.19 runs them when it builds a prompt
// (extensions/regex/engine.js), on V8's linear-time engine and within a time and output
// budget (ARCHITECTURE §15).
import { setFlagsFromString } from "node:v8"
import { createContext, Script } from "node:vm"
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
  const [pattern, flags] = m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3]) ? [source, ""] : [m[2]!, m[3] ?? ""]
  return compileLinear(pattern, flags)
}

/** The assembler's safe engine, shared by scripts and lorebook keys. */
export const compileLinear = (pattern: string, flags: string): RegExp | "unsafe" | null => {
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

/** A compiled script, its replacement and trim strings expanded. */
export interface PromptScript {
  readonly script: RegexScript
  readonly regex: RegExp
  readonly replacement: string
  readonly trim: ReadonlyArray<string>
}

const minBounded = (script: RegexScript) => script.min_depth !== null && script.min_depth >= -1
const maxBounded = (script: RegexScript) => script.max_depth !== null && script.max_depth >= 0

/** Whether ST runs a prompt-only script on a message at this depth (getRegexedString). */
const withinDepth = (script: RegexScript, depth: number) =>
  (!minBounded(script) || depth >= script.min_depth!) && (!maxBounded(script) || depth <= script.max_depth!)

/** Runs `job()` in a context of its own, so a timeout can stop it. */
const JOB = new Script("job()")

/** A cumulative VM deadline; even a single engine call can be interrupted. */
export const makeRegexDeadline = (limit: number) => {
  const context = createContext({ job: undefined })
  let ms = limit
  return {
    get expired() {
      return ms <= 0
    },
    run: (job: () => void) => {
      if (ms <= 0) return false
      context.job = job
      const start = performance.now()
      try {
        JOB.runInContext(context, { timeout: Math.max(1, Math.ceil(ms)) })
        return true
      } catch (error) {
        if ((error as { code?: string }).code !== "ERR_SCRIPT_EXECUTION_TIMEOUT") throw error
        ms = 0
        return false
      } finally {
        context.job = undefined
        if (ms > 0) ms -= performance.now() - start
      }
    }
  }
}

/**
 * A preset's scripts for one context, with the time (`ms`) and the text (`output`) they may
 * still spend; each batch runs as a vm script whose timeout V8 enforces.
 */
export const makeScriptRunner = (list: ReadonlyArray<PromptScript>, limits: { ms: number; output: number }) => {
  const deadline = makeRegexDeadline(limits.ms)
  const output = { left: limits.output }
  return {
    list,
    /** Whether the scripts ran out of time. */
    get expired() {
      return deadline.expired
    },
    /**
     * Each message's text after the scripts, and whether it can change as the chat grows: a
     * depth-bounded script applies now and stops at a later depth, or doesn't apply yet and
     * matches, or a script was skipped for it (out of time or output, which the messages
     * read before it spent). Messages the time didn't cover keep their text.
     */
    apply: (items: ReadonlyArray<{ readonly text: string; readonly placement: number; readonly depth: number }>) => {
      const applies = (item: (typeof items)[number]) =>
        list.some(({ script }) => !script.disabled && script.prompt_only && script.placement.includes(item.placement))
      const results = items.map((item) => ({ text: item.text, volatile: applies(item) }))
      const failed = new Map<PromptScript, string>()
      if (list.length === 0 || items.length === 0 || deadline.expired) return { results, failed }
      deadline.run(() => {
        items.forEach((item, i) => {
          let { text } = item
          let volatile = false
          for (const entry of list) {
            const { script, regex } = entry
            if (script.disabled || !script.prompt_only || !script.placement.includes(item.placement)) continue
            try {
              if (!withinDepth(script, item.depth)) {
                regex.lastIndex = 0
                if (minBounded(script) && item.depth < script.min_depth! && regex.test(text)) volatile = true
                continue
              }
              const next = run(regex, entry.replacement, entry.trim, text, output)
              if (maxBounded(script) && next !== text) volatile = true
              text = next
            } catch (error) {
              volatile = true
              if (!failed.has(entry)) {
                failed.set(
                  entry,
                  error instanceof OutputLimit ? "it made more text than one context allows" : String(error)
                )
              }
            }
          }
          results[i] = { text, volatile }
        })
      })
      return { results, failed }
    }
  }
}

export type ScriptRunner = ReturnType<typeof makeScriptRunner>
