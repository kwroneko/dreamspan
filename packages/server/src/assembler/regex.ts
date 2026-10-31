import { run, OutputLimit } from "@rp/shared/regexReplace.ts"
export { run } from "@rp/shared/regexReplace.ts"
// A preset's prompt-only regex scripts, as ST 1.19 runs them when it builds a prompt
// (extensions/regex/engine.js), on V8's linear-time engine and within a time and output
// budget (ARCHITECTURE §15).
import { setFlagsFromString } from "node:v8"
import { createContext, Script } from "node:vm"
import type { RegexScript } from "@rp/shared/docs/preset.ts"
import { OUT_OF_TIME, type ScriptFailure, type ScriptRef, type TextRewrite } from "@rp/shared/regexScripts.ts"
import type { Assembly } from "./pipeline.ts"

setFlagsFromString("--enable-experimental-regexp-engine")

/** ST's placements: what a script applies to. */
export const PLACEMENT = { userInput: 1, aiOutput: 2, worldInfo: 5, reasoning: 6 } as const

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
  /** Which list it came from, for the inspector and the message's record. */
  readonly ref: ScriptRef
  readonly script: RegexScript
  readonly regex: RegExp
  readonly replacement: string
  readonly trim: ReadonlyArray<string>
}

const minBounded = (script: RegexScript) => script.min_depth !== null && script.min_depth >= -1
const maxBounded = (script: RegexScript) => script.max_depth !== null && script.max_depth >= 0

/** Whether ST runs a prompt-only script on a message at this depth (getRegexedString); no depth: always. */
const withinDepth = (script: RegexScript, depth: number | null) =>
  depth === null ||
  ((!minBounded(script) || depth >= script.min_depth!) && (!maxBounded(script) || depth <= script.max_depth!))

/** What a script that threw is reported with. */
const why = (error: unknown) =>
  error instanceof OutputLimit ? "it made more text than one context allows" : String(error)

/** ST runs a script with neither flag on text as it's written; `markdown_only` ones only on display. */
const rewritesStored = (script: RegexScript) => !script.prompt_only && !script.markdown_only

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
    apply: (
      items: ReadonlyArray<{ readonly text: string; readonly placement: number; readonly depth: number | null }>
    ) => {
      const applies = (item: (typeof items)[number]) =>
        list.some(({ script }) => !script.disabled && script.prompt_only && script.placement.includes(item.placement))
      const results: Array<{ text: string; volatile: boolean; applied?: ReadonlyArray<ScriptRef> }> = items.map(
        (item) => ({ text: item.text, volatile: applies(item) })
      )
      const failed = new Map<PromptScript, string>()
      if (list.length === 0 || items.length === 0 || deadline.expired) return { results, failed }
      deadline.run(() => {
        items.forEach((item, i) => {
          let { text } = item
          let volatile = false
          const applied: Array<ScriptRef> = []
          for (const entry of list) {
            const { script, regex } = entry
            if (script.disabled || !script.prompt_only || !script.placement.includes(item.placement)) continue
            try {
              if (!withinDepth(script, item.depth)) {
                regex.lastIndex = 0
                if (minBounded(script) && item.depth! < script.min_depth! && regex.test(text)) volatile = true
                continue
              }
              const next = run(regex, entry.replacement, entry.trim, text, output)
              if (maxBounded(script) && next !== text) volatile = true
              if (next !== text) applied.push(entry.ref)
              text = next
            } catch (error) {
              volatile = true
              if (!failed.has(entry)) failed.set(entry, why(error))
            }
          }
          results[i] = { text, volatile, ...(applied.length ? { applied } : {}) }
        })
      })
      return { results, failed }
    },
    /**
     * Texts as they're written (ST's getRegexedString without `isPrompt` or `isMarkdown`): the
     * scripts with neither flag, for the placement, in order, and with no depth, as ST passes
     * none there. On an edit only those that run on edits. A script that throws is skipped
     * for that text; one still running when the time runs out leaves the whole text as it was.
     */
    rewrite: (
      items: ReadonlyArray<{ readonly text: string; readonly placement: number }>,
      options: { readonly edit: boolean }
    ): Array<TextRewrite> =>
      items.map((item) => {
        const scripts = list.filter(
          ({ script }) =>
            !script.disabled &&
            rewritesStored(script) &&
            script.placement.includes(item.placement) &&
            (!options.edit || script.run_on_edit)
        )
        if (scripts.length === 0 || item.text === "") return { text: item.text, applied: [], failed: [] }
        let text = item.text
        const applied: Array<ScriptRef> = []
        const failed: Array<ScriptFailure> = []
        let current: PromptScript | undefined
        const done = deadline.run(() => {
          for (const entry of scripts) {
            current = entry
            try {
              const next = run(entry.regex, entry.replacement, entry.trim, text, output)
              if (next !== text) applied.push(entry.ref)
              text = next
            } catch (error) {
              failed.push({ script: entry.ref, reason: `it failed: ${why(error)}` })
            }
          }
          current = undefined
        })
        if (done) return { text, applied, failed }
        // Out of time: nothing of this text's partial work is kept.
        const reason = OUT_OF_TIME
        return {
          text: item.text,
          applied: [],
          failed: [{ script: (current ?? scripts[0]!).ref, reason }]
        }
      })
  }
}

export type ScriptRunner = ReturnType<typeof makeScriptRunner>

/** One context's time for the regex scripts: V8 stops them once it's spent. */
export const REGEX_MS = 200

/** Characters of text the scripts may make for one context, copied or replaced. */
export const REGEX_OUTPUT = 8_000_000

/** The scripts' text for these messages, as one batch; what stopped them is reported once. */
export const applyScripts = (
  assembly: Assembly,
  runner: ScriptRunner,
  items: ReadonlyArray<{ readonly text: string; readonly placement: number; readonly depth: number | null }>
) => {
  const expired = runner.expired
  const { results, failed } = runner.apply(items)
  const report = (message: string) => {
    if (!assembly.issues.some((i) => i.message === message)) assembly.issues.push({ kind: "regex_skipped", message })
  }
  for (const [{ script }, why] of failed)
    report(`The regex script "${script.name}" was skipped where it failed: ${why}.`)
  if (!expired && runner.expired && runner.list.length > 0) {
    report(
      `The regex scripts ran out of time (${REGEX_MS} ms for one context): the rest of the messages are sent without them.`
    )
  }
  return results
}
