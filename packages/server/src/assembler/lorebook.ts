import type { LorebookDoc, LorebookEntry, SelectiveLogic } from "@rp/shared/docs/lorebook.ts"
import { compileLinear, makeRegexDeadline } from "./regex.ts"

interface Book {
  readonly id: string
  readonly document: LorebookDoc
}

type Description =
  | "persona_description"
  | "character_description"
  | "character_personality"
  | "character_depth_prompt"
  | "scenario"
  | "creator_notes"

interface Scan {
  /** Prepared prompt text, including names if wanted, newest first. */
  readonly messages: ReadonlyArray<string>
  readonly descriptions?: Partial<Record<Description, string>>
  readonly injections?: ReadonlyArray<{ readonly text: string; readonly scan: boolean }>
  readonly trigger?: string
}

interface Settings {
  readonly budget: number
  readonly scanDepth?: number
  readonly caseSensitive?: boolean
  readonly wholeWords?: boolean
  readonly recursive?: boolean
  /** Includes the initial pass; capped at 64 even if the caller asks for more. */
  readonly maxSteps?: number
  readonly groupScoring?: boolean
  readonly regexMs?: number
}

interface Source {
  readonly book: string
  readonly entry: LorebookEntry
}

type Why =
  | { readonly kind: "constant" }
  | {
      readonly kind: "keys"
      readonly primaryKey: string
      readonly secondaryKeys: ReadonlyArray<string>
      readonly logic?: SelectiveLogic
    }

interface Activation extends Source {
  readonly step: number
  readonly why: Why
}

type SkipReason =
  | "disabled"
  | "trigger"
  | "delay"
  | "recursion"
  | "no_primary"
  | "secondary"
  | "regex"
  | "probability"
  | "group"
  | "budget"

interface Skipped extends Source {
  readonly step: number
  readonly reason: SkipReason
}

interface Issue {
  readonly book: string
  readonly uid: number
  readonly code: "invalid_regex" | "unsafe_regex" | "regex_timeout" | "regex_limit" | "unsupported" | "recursion_limit"
  readonly detail: string
  readonly key?: string
}

const descriptions: ReadonlyArray<Description> = [
  "persona_description",
  "character_description",
  "character_personality",
  "character_depth_prompt",
  "scenario",
  "creator_notes"
]
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const secondaryPasses = (logic: SelectiveLogic, matches: ReadonlyArray<boolean>) => {
  switch (logic) {
    case "and_any":
      return matches.some(Boolean)
    case "and_all":
      return matches.every(Boolean)
    case "not_any":
      return !matches.some(Boolean)
    case "not_all":
      return !matches.every(Boolean)
  }
}

/** No storage or pipeline work. Entries, keys, descriptions and content are already macro-resolved. */
export const matchLorebooks = (
  books: ReadonlyArray<Book>,
  scan: Scan,
  settings: Settings,
  random: () => number,
  countTokens: (text: string) => number
) => {
  const sources = books
    .flatMap((book) => book.document.entries.map((entry) => ({ book: book.id, entry, document: book.document })))
    .sort((a, b) => b.entry.order - a.entry.order)
  const activated = new Map<(typeof sources)[number], Activation>()
  const skipped = new Map<(typeof sources)[number], Skipped>()
  const failedProbability = new Set<(typeof sources)[number]>()
  const issues: Array<Issue> = []
  const issueKeys = new Set<string>()
  const issue = (source: Source, code: Issue["code"], detail: string, key?: string) => {
    const id = JSON.stringify([source.book, source.entry.uid, code, key, detail])
    if (issueKeys.has(id)) return
    issueKeys.add(id)
    issues.push({ book: source.book, uid: source.entry.uid, code, detail, ...(key === undefined ? {} : { key }) })
  }
  const deadline = makeRegexDeadline(settings.regexMs ?? 200)
  const patterns = new Map<string, RegExp | "literal" | "invalid" | "unsafe" | "limit" | "timeout">()
  const keyMatch = (source: Source, haystack: string, original: string, trim: boolean): boolean | undefined => {
    if (!original) return false
    const key = trim ? original.trim() : original
    let pattern = patterns.get(key)
    if (pattern === undefined) {
      const parsed = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(key)
      pattern = "literal"
      if (parsed && !/(^|[^\\])\//.test(parsed[1]!)) {
        if (parsed[1]!.length > 2000) pattern = "limit"
        else {
          const result: { regex: ReturnType<typeof compileLinear> } = { regex: null }
          const completed = deadline.run(() => {
            result.regex = compileLinear(parsed[1]!.replace(/\\\//, "/"), parsed[2]!)
          })
          const compiled = result.regex
          if (!completed) pattern = "timeout"
          else if (compiled === null) pattern = "invalid"
          else pattern = compiled instanceof RegExp && compiled.source.length > 2000 ? "limit" : compiled
        }
      } else if (key.startsWith("/") && key !== "//") {
        pattern = "invalid"
      }
      patterns.set(key, pattern)
    }
    if (pattern instanceof RegExp) {
      let matched = false
      if (
        !deadline.run(() => {
          pattern.lastIndex = 0
          matched = pattern.test(haystack)
        })
      ) {
        issue(source, "regex_timeout", "Lorebook regex time allowance exhausted.", key)
        return undefined
      }
      return matched
    }
    if (pattern === "invalid") issue(source, "invalid_regex", "Invalid ST slash regex; matched as literal text.", key)
    if (pattern !== "literal" && pattern !== "invalid") {
      const code = pattern === "unsafe" ? "unsafe_regex" : pattern === "limit" ? "regex_limit" : "regex_timeout"
      issue(
        source,
        code,
        pattern === "unsafe"
          ? "The linear-time engine cannot run this regex."
          : pattern === "limit"
            ? "Regex exceeds 2,000 characters."
            : "Lorebook regex time allowance exhausted.",
        key
      )
      return undefined
    }
    const sensitive = source.entry.case_sensitive ?? settings.caseSensitive ?? false
    const text = sensitive ? haystack : haystack.toLowerCase()
    const needle = sensitive ? key : key.toLowerCase()
    if (!(source.entry.match_whole_words ?? settings.wholeWords ?? true) || needle.split(/\s+/).length > 1)
      return text.includes(needle)
    return new RegExp(`(?:^|\\W)(${escape(needle)})(?:$|\\W)`).test(text)
  }
  const messages = scan.messages.slice(0, 1000).map((message) => message.trim())
  const injections = (scan.injections ?? [])
    .filter((injection) => injection.scan && injection.text)
    .map((injection) => injection.text)
  const recursion: Array<string> = []
  const buffer = (source: (typeof sources)[number]) => {
    const depth = Math.min(1000, source.entry.scan_depth ?? source.document.scan_depth ?? settings.scanDepth ?? 2)
    if (depth <= 0) return ""
    const chat = "\x01" + messages.slice(0, depth).join("\n\x01")
    const blocks: Array<string> = []
    for (const name of descriptions) {
      const value = scan.descriptions?.[name]
      if (source.entry[`match_${name}`] && value) blocks.push(value)
    }
    const extra = [...blocks, ...injections, ...recursion]
    return chat + (extra.length ? "\n\x01" + extra.join("\n\x01") : "")
  }
  const recursive = (source: (typeof sources)[number]) =>
    source.document.recursive_scanning ?? settings.recursive ?? true
  const scoredGroups = new Set(
    sources.filter((source) => source.entry.use_group_scoring).map((source) => source.entry.group)
  )
  const admittedGroups = new Set<string>()
  const maxSteps = Math.max(1, Math.min(64, settings.maxSteps ?? 16))
  let charged = ""
  const bookCharged = new Map<string, string>()
  let overflow = false
  let step = 0
  const skip = (source: (typeof sources)[number], reason: SkipReason) =>
    skipped.set(source, { book: source.book, entry: source.entry, step, reason })
  for (const source of sources) {
    const entry = source.entry
    const unsupported: Array<string> = []
    if (entry.sticky || entry.cooldown) unsupported.push("sticky/cooldown")
    if (entry.character_filter) unsupported.push("character filters")
    if (entry.group.includes(",")) unsupported.push("overlapping groups (group treated as one name)")
    if (entry.group && entry.group_weight !== 100) unsupported.push("group weights (deterministic choice)")
    if (entry.vectorized || entry.automation_id || /^@@(?:activate|dont_activate)/.test(entry.content))
      unsupported.push("vector/external/decorator activation")
    if (unsupported.length) issue(source, "unsupported", unsupported.join("; "))
  }
  for (; step < maxSteps; step++) {
    const candidates: Array<{ source: (typeof sources)[number]; why: Why; score: number }> = []
    for (const source of sources) {
      if (activated.has(source) || failedProbability.has(source)) continue
      const entry = source.entry
      if (!entry.enabled) {
        skip(source, "disabled")
        continue
      }
      if (entry.triggers.length && !entry.triggers.includes(scan.trigger ?? "normal")) {
        skip(source, "trigger")
        continue
      }
      if (entry.delay !== null && entry.delay > scan.messages.length) {
        skip(source, "delay")
        continue
      }
      const delayed = Number(entry.delay_until_recursion)
      if ((delayed && step < delayed) || (step > 0 && (!recursive(source) || entry.exclude_recursion))) {
        skip(source, "recursion")
        continue
      }
      const text = buffer(source)
      let why: Why = { kind: "constant" }
      if (!entry.constant) {
        let primaryKey: string | undefined
        let unsafe = false
        for (const key of entry.keys) {
          const matched = keyMatch(source, text, key, true)
          if (matched === undefined) unsafe = true
          if (matched) {
            primaryKey = key
            break
          }
        }
        if (primaryKey === undefined) {
          skip(source, unsafe ? "regex" : "no_primary")
          continue
        }
        unsafe = false
        const secondaryKeys: Array<string> = []
        if (entry.selective && entry.secondary_keys.length) {
          const matches = entry.secondary_keys.map((key) => {
            const matched = keyMatch(source, text, key, true)
            if (matched === undefined) unsafe = true
            if (matched) secondaryKeys.push(key)
            return matched ?? false
          })
          if (unsafe) {
            skip(source, "regex")
            continue
          }
          if (!secondaryPasses(entry.selective_logic, matches)) {
            skip(source, "secondary")
            continue
          }
        }
        why = {
          kind: "keys",
          primaryKey,
          secondaryKeys,
          ...(entry.selective && entry.secondary_keys.length ? { logic: entry.selective_logic } : {})
        }
      }
      let score = 0
      if (entry.group && (settings.groupScoring || scoredGroups.has(entry.group))) {
        const primary = entry.keys.filter((key) => keyMatch(source, text, key, false)).length
        const secondary = entry.secondary_keys.filter((key) => keyMatch(source, text, key, false)).length
        score = primary
        if (
          primary &&
          (entry.selective_logic === "and_any" ||
            (entry.selective_logic === "and_all" && secondary === entry.secondary_keys.length))
        )
          score += secondary
      }
      candidates.push({ source, why, score })
    }
    const groups = new Map<string, typeof candidates>()
    for (const candidate of candidates) {
      const group = candidate.source.entry.group
      if (group) {
        const members = groups.get(group)
        if (members) members.push(candidate)
        else groups.set(group, [candidate])
      }
    }
    const losers = new Set<(typeof sources)[number]>()
    for (const [group, members] of groups) {
      if (admittedGroups.has(group)) {
        for (const member of members) losers.add(member.source)
        continue
      }
      const maxScore = members.reduce((max, member) => Math.max(max, member.score), 0)
      const eligible = members.filter(
        (member) =>
          !(member.source.entry.use_group_scoring ?? settings.groupScoring ?? false) || member.score === maxScore
      )
      const winner = eligible.find((member) => member.source.entry.group_override) ?? eligible[0]!
      for (const member of members) if (member !== winner) losers.add(member.source)
    }
    let newContent = ""
    const newBookContent = new Map<string, string>()
    const contributions: Array<string> = []
    for (const { source, why } of candidates) {
      const entry = source.entry
      if (losers.has(source)) {
        skip(source, "group")
        continue
      }
      if (overflow && !entry.ignore_budget) {
        skip(source, "budget")
        continue
      }
      if (entry.use_probability && entry.probability !== 100 && random() * 100 > entry.probability) {
        skip(source, "probability")
        failedProbability.add(source)
        continue
      }
      newContent += entry.content + "\n"
      const forBook = (newBookContent.get(source.book) ?? "") + entry.content + "\n"
      newBookContent.set(source.book, forBook)
      const bookBudget = source.document.token_budget
      if (
        !entry.ignore_budget &&
        (countTokens(charged) + countTokens(newContent) >= settings.budget ||
          (bookBudget !== null &&
            bookBudget > 0 &&
            countTokens(bookCharged.get(source.book) ?? "") + countTokens(forBook) >= bookBudget))
      ) {
        skip(source, "budget")
        overflow = true
        continue
      }
      activated.set(source, { book: source.book, entry, step, why })
      skipped.delete(source)
      if (entry.group) admittedGroups.add(entry.group)
      if (recursive(source) && !entry.prevent_recursion) contributions.push(entry.content)
    }
    charged += newContent
    for (const [book, content] of newBookContent) bookCharged.set(book, (bookCharged.get(book) ?? "") + content)
    if (overflow) break
    const text = contributions.join("\n")
    if (text) recursion.push(text)
    const pendingDelay = sources.some(
      (source) =>
        source.entry.enabled &&
        !activated.has(source) &&
        !failedProbability.has(source) &&
        recursive(source) &&
        !source.entry.exclude_recursion &&
        Number(source.entry.delay_until_recursion) > step
    )
    if (!contributions.length && !pendingDelay) break
  }
  if (step === maxSteps) {
    for (const source of sources)
      if (!activated.has(source) && recursive(source))
        issue(source, "recursion_limit", `Stopped after ${maxSteps} activation passes.`)
  }
  return {
    activated: sources.flatMap((source) => activated.get(source) ?? []),
    skipped: sources.flatMap((source) => skipped.get(source) ?? []),
    issues
  }
}
