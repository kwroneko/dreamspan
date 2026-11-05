import type { LorebookDoc, LorebookEntry, SelectiveLogic } from "@rp/shared/docs/lorebook.ts"
import { loreEntryKey } from "./loreTiming.ts"
import { characterFilterPasses } from "@rp/shared/lorebookFilters.ts"
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
  /** Eligible messages on the full path, independently of the scan window. */
  readonly messageCount?: number
  readonly effects?: ReadonlyMap<string, { readonly sticky: boolean; readonly cooldown: boolean }>
  readonly speaker?: { readonly entity: string; readonly name?: string; readonly tags?: ReadonlyArray<string> }
  readonly descriptions?: Partial<Record<Description, string>>
  /**
   * Extension prompts scanned as ST's `addInject` adds them: all of them, whatever the scan
   * depth. `name` names one in an activation's reason when its text has the primary key.
   */
  readonly injections?: ReadonlyArray<{ readonly text: string; readonly scan: boolean; readonly name?: string }>
  readonly trigger?: string
  /** Model admissions replace keyword matching, subject to the normal entry gates and budgets. */
  readonly decisions?: ReadonlyMap<string, number>
}

const workLimits = {
  keyEvaluations: 100000,
  scannedCharacters: 128000000,
  regexWork: 500000,
  patterns: 4096,
  patternCharacters: 131072,
  compiledUnits: 262144,
  bufferCharacters: 8000000,
  indexedWords: 100000,
  matchResults: 20000,
  buffers: 4096,
  tokenCharacters: 8000000,
  issueCount: 1000
}

interface Settings {
  readonly budget: number
  /** Our layouts reserve this fixed tail allowance, including message overhead; ignore_budget cannot bypass it. */
  readonly hardBudget?: number
  readonly scanDepth?: number
  readonly caseSensitive?: boolean
  readonly wholeWords?: boolean
  readonly recursive?: boolean
  /** Includes the initial pass; capped at 64 even if the caller asks for more. */
  readonly maxSteps?: number
  readonly groupScoring?: boolean
  /** Emergency guard only. A timeout makes the result non-replayable. */
  readonly regexMs?: number
  /** Callers may lower, but cannot raise, these per-activation limits. */
  readonly workLimits?: Partial<typeof workLimits>
}

interface Source {
  readonly book: string
  readonly entry: LorebookEntry
}

type Why =
  | { readonly kind: "constant" }
  | { readonly kind: "sticky" }
  | { readonly kind: "decision"; readonly probability: number }
  | {
      readonly kind: "keys"
      readonly primaryKey: string
      readonly secondaryKeys: ReadonlyArray<string>
      readonly logic?: SelectiveLogic
      /** The scanned extension prompts whose own text has the primary key, by name. */
      readonly notes?: ReadonlyArray<string>
    }

interface Activation extends Source {
  readonly step: number
  readonly why: Why
}

type SkipReason =
  | "disabled"
  | "trigger"
  | "delay"
  | "cooldown"
  | "character_filter"
  | "recursion"
  | "no_primary"
  | "secondary"
  | "regex"
  | "probability"
  | "group"
  | "budget"
  | "work_limit"
  | "error"

interface Skipped extends Source {
  readonly step: number
  readonly reason: SkipReason
}

interface Issue {
  readonly book: string
  readonly uid: number
  readonly code:
    | "invalid_regex"
    | "unsafe_regex"
    | "regex_timeout"
    | "regex_limit"
    | "unsupported"
    | "recursion_limit"
    | "work_limit"
    | "evaluation_error"
  readonly detail: string
  readonly key?: string
  count: number
  readonly examples: Array<{ book: string; uid: number; key?: string }>
}

const descriptions: ReadonlyArray<Description> = [
  "persona_description",
  "character_description",
  "character_personality",
  "character_depth_prompt",
  "scenario",
  "creator_notes"
]
const wordCharacter = (text: string, index: number) => {
  const code = text.charCodeAt(index)
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || code === 95 || (code >= 97 && code <= 122)
}

const refusedConstruct = (pattern: string) => {
  if (pattern.includes("(?!")) return "Negative lookahead is unsupported; use a secondary key with NOT ANY."
  if (pattern.includes("(?=")) return "Lookahead is unsupported; use a secondary key with AND ANY."
  if (/\(\?<[=!]/.test(pattern))
    return "Lookbehind with captures or unsupported assertions; remove captures or use a literal prefix."
  if (/\\[1-9]|\\k</.test(pattern)) return "Backreference is unsupported; repeat the literal text instead."
  if (/\\[pP]\{/.test(pattern)) return "Unicode property escapes are unsupported; use an explicit character class."
  if (/\\u\{/.test(pattern)) return "Unicode code-point escapes are unsupported; use the literal character instead."
  return "The linear engine refuses this construct; simplify nested or large counted repetitions."
}

// Counted repeats expand V8's program. Multiplying even disjoint repeats deliberately overestimates it.
const compiledUnits = (pattern: string, characters: number) => {
  let units = characters
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "\\") i++
    else if (char === "[") inClass = true
    else if (char === "]") inClass = false
    else if (!inClass && char === "{") {
      const repeat = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i))
      if (repeat) {
        const count =
          repeat[2] === undefined ? Number(repeat[1]) : repeat[2] === "" ? Number(repeat[1]) + 1 : Number(repeat[2])
        units *= Math.max(1, count)
        i += repeat[0].length - 1
      }
    }
  }
  return units
}

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

/** Pure activation. Keys/descriptions are resolved; content can be previewed lazily on admission. */
export const matchLorebooks = (
  books: ReadonlyArray<Book>,
  scan: Scan,
  settings: Settings,
  random: () => number,
  countTokens: (text: string) => number,
  previewContent?: (source: Source) => string | undefined
) => {
  const previews = new Map<Source, string | undefined>()
  const sources = books
    .flatMap((book) => book.document.entries.map((entry) => ({ book: book.id, entry, document: book.document })))
    .sort((a, b) => b.entry.order - a.entry.order)
  const activated = new Map<(typeof sources)[number], Activation>()
  const skipped = new Map<(typeof sources)[number], Skipped>()
  const failedProbability = new Set<(typeof sources)[number]>()
  const issues: Array<Issue> = []
  const issueGroups = new Map<string, Issue>()
  const work = {
    keyEvaluations: 0,
    scannedCharacters: 0,
    regexWork: 0,
    tokenCharacters: 0,
    issueCount: 0,
    buffers: 0,
    patterns: 0,
    patternCharacters: 0,
    compiledUnits: 0,
    bufferCharacters: 0,
    indexedWords: 0,
    matchResults: 0
  }
  const halted = Symbol("activation stopped")
  let replayable = true
  let stopped: SkipReason | undefined
  let currentSource: Source | undefined = sources[0]
  const recordIssue = (source: Source, code: Issue["code"], detail: string, key?: string) => {
    const id = JSON.stringify([code, detail])
    const example = {
      book: source.book,
      uid: source.entry.uid,
      ...(key === undefined ? {} : { key: key.slice(0, 160) })
    }
    const previous = issueGroups.get(id)
    if (previous) {
      previous.count++
      if (previous.examples.length < 3) previous.examples.push(example)
    } else {
      const item = { ...example, code, detail, count: 1, examples: [example] }
      issueGroups.set(id, item)
      issues.push(item)
    }
  }
  const charge = (source: Source, kind: keyof typeof workLimits, amount: number) => {
    const limit = Math.max(0, Math.min(workLimits[kind], settings.workLimits?.[kind] ?? workLimits[kind]))
    if (amount > limit - work[kind]) {
      stopped = "work_limit"
      recordIssue(source, "work_limit", `Activation stopped at the ${kind} work limit (${limit}); results are partial.`)
      throw halted
    }
    const combined =
      work.scannedCharacters +
      256 * work.regexWork +
      (kind === "scannedCharacters" ? amount : kind === "regexWork" ? 256 * amount : 0)
    if (combined > workLimits.scannedCharacters) {
      stopped = "work_limit"
      recordIssue(
        source,
        "work_limit",
        "Activation stopped at the combined scan/regex work limit (128000000); results are partial."
      )
      throw halted
    }
    work[kind] += amount
  }
  const issue = (source: Source, code: Issue["code"], detail: string, key?: string) => {
    charge(source, "issueCount", 1)
    recordIssue(source, code, detail, key)
  }
  const tokenCounts = new Map<string, number>()
  const tokens = (source: Source, text: string) => {
    const cached = tokenCounts.get(text)
    if (cached !== undefined) return cached
    charge(source, "tokenCharacters", text.length)
    const count = countTokens(text)
    tokenCounts.set(text, count)
    return count
  }
  const patterns = new Map<string, RegExp | "literal" | "invalid" | "unsafe" | "limit">()
  interface Buffer {
    text: string
    lower?: string
    words?: Set<string>
    lowerWords?: Set<string>
    regexMatches?: Map<RegExp, boolean>
  }
  const wordMatch = (source: Source, buffer: Buffer, text: string, sensitive: boolean, needle: string) => {
    const field = sensitive ? "words" : "lowerWords"
    let words = buffer[field]
    if (words === undefined) {
      charge(source, "scannedCharacters", text.length)
      words = new Set()
      for (const match of text.matchAll(/\w+/g)) {
        if (!words.has(match[0])) {
          charge(source, "indexedWords", 1)
          charge(source, "bufferCharacters", match[0].length)
          words.add(match[0])
        }
      }
      buffer[field] = words
    }
    return words.has(needle)
  }
  const keyMatch = (source: Source, buffer: Buffer, original: string, trim: boolean): boolean | undefined => {
    charge(source, "keyEvaluations", 1)
    if (trim && !original) return false
    charge(source, "scannedCharacters", original.length)
    const key = trim ? original.trim() : original
    let pattern = patterns.get(key)
    if (pattern === undefined) {
      const parsed = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(key)
      pattern = "literal"
      if (key.startsWith("/") && key !== "//") {
        charge(source, "patterns", 1)
        const body = parsed?.[1] ?? ""
        const sourceCharacters =
          (body.length + 5 * (body.match(/[\n\r\u2028\u2029]/g)?.length ?? 0) + (body.match(/\//g)?.length ?? 0)) *
          (parsed?.[2]?.includes("i") ? 4 : 1)
        charge(source, "patternCharacters", key.length + sourceCharacters)
      }
      if (parsed && !/(^|[^\\])\//.test(parsed[1]!)) {
        if (parsed[1]!.length > 2000) pattern = "limit"
        else {
          const sourcePattern = parsed[1]!.replace(/\\\//, "/")
          charge(
            source,
            "compiledUnits",
            compiledUnits(sourcePattern, sourcePattern.length * (parsed[2]!.includes("i") ? 4 : 1))
          )
          const compiled = compileLinear(sourcePattern, parsed[2]!)
          if (compiled === null) pattern = "invalid"
          else pattern = compiled instanceof RegExp && compiled.source.length > 2000 ? "limit" : compiled
        }
      } else if (key.startsWith("/") && key !== "//") {
        pattern = "invalid"
      }
      if (pattern !== "literal") patterns.set(key, pattern)
    }
    if (pattern instanceof RegExp) {
      const cached = buffer.regexMatches?.get(pattern)
      if (cached !== undefined) return cached
      const word = pattern.sticky ? undefined : /^\\b(\w+)\\b$/.exec(pattern.source)?.[1]
      const literal = pattern.sticky ? undefined : /^\(\?:(\w+)\)$/.exec(pattern.source)?.[1]
      charge(source, "matchResults", 1)
      let matched: boolean
      if (word !== undefined) matched = wordMatch(source, buffer, buffer.text, true, word)
      else if (literal !== undefined) {
        charge(source, "scannedCharacters", buffer.text.length)
        matched = buffer.text.includes(literal)
      } else {
        const cost = compiledUnits(pattern.source, pattern.source.length) * Math.max(1, buffer.text.length)
        if (cost > 250000) {
          issue(
            source,
            "regex_limit",
            "Regex pattern size × input size exceeds 250,000; shorten the pattern or scan depth.",
            key
          )
          return undefined
        }
        charge(source, "regexWork", cost)
        charge(source, "scannedCharacters", buffer.text.length)
        pattern.lastIndex = 0
        matched = pattern.test(buffer.text)
      }
      buffer.regexMatches ??= new Map()
      buffer.regexMatches.set(pattern, matched)
      return matched
    }
    if (pattern === "invalid") issue(source, "invalid_regex", "Invalid /regex/ key; matched as literal text.", key)
    if (pattern === "unsafe" || pattern === "limit") {
      issue(
        source,
        pattern === "unsafe" ? "unsafe_regex" : "regex_limit",
        pattern === "unsafe" ? refusedConstruct(key) : "Regex exceeds 2,000 characters; shorten the pattern.",
        key
      )
      return undefined
    }
    const sensitive = source.entry.case_sensitive ?? settings.caseSensitive ?? false
    if (!sensitive && buffer.lower === undefined) {
      charge(source, "bufferCharacters", buffer.text.length * 3)
      buffer.lower = buffer.text.toLowerCase()
    }
    const text = sensitive ? buffer.text : buffer.lower!
    const needle = sensitive ? key : key.toLowerCase()
    const wholeWords = source.entry.match_whole_words ?? settings.wholeWords ?? true
    if (wholeWords && /^\w+$/.test(needle)) return wordMatch(source, buffer, text, sensitive, needle)
    charge(source, "scannedCharacters", text.length)
    if (!wholeWords || /\s/.test(needle)) return text.includes(needle)
    let index = text.indexOf(needle)
    while (index !== -1) {
      charge(source, "scannedCharacters", needle.length)
      if (!wordCharacter(text, index - 1) && !wordCharacter(text, index + needle.length)) return true
      index = text.indexOf(needle, index + 1)
      if (index === text.length && needle.length === 0) return !wordCharacter(text, index - 1)
    }
    return false
  }
  // ST keeps holes at interior empty messages, but does not extend the array for trailing ones.
  let messageLength = Math.min(1000, scan.messages.length)
  while (messageLength && !scan.messages[messageLength - 1]) messageLength--
  const messages: Array<string> = new Array(messageLength)
  let preparedDepth = 0
  const scanned = (scan.injections ?? []).filter((injection) => injection.scan && injection.text)
  const injections = scanned.map((injection) => injection.text)
  // Each named prompt on its own, to say which of them has an entry's primary key.
  const named = scanned.flatMap((injection) =>
    injection.name === undefined ? [] : [{ name: injection.name, buffer: { text: "\x01" + injection.text } as Buffer }]
  )
  const recursion: Array<string> = []
  const chats = new Map<number, string>()
  const buffers = new Map<string, Buffer>()
  const buffer = (source: (typeof sources)[number]): Buffer => {
    const depth = Math.min(1000, source.entry.scan_depth ?? source.document.scan_depth ?? settings.scanDepth ?? 2)
    if (depth <= 0) return { text: "" }
    for (; preparedDepth < Math.min(depth, scan.messages.length); preparedDepth++) {
      const message = scan.messages[preparedDepth]
      if (message) {
        charge(source, "scannedCharacters", message.length)
        charge(source, "bufferCharacters", message.length)
        messages[preparedDepth] = message.trim()
      }
    }
    const names = descriptions.filter((name) => source.entry[`match_${name}`])
    const id = `${depth}:${names.join(",")}`
    const cached = buffers.get(id)
    if (cached) return cached
    charge(source, "buffers", 1)
    let chat = chats.get(depth)
    if (chat === undefined) {
      const slice = messages.slice(0, depth)
      const length = 1 + slice.reduce((sum, text) => sum + text.length, 0) + Math.max(0, slice.length - 1) * 2
      charge(source, "scannedCharacters", length)
      charge(source, "bufferCharacters", length)
      chat = "\x01" + slice.join("\n\x01")
      chats.set(depth, chat)
    }
    const blocks = names.map((name) => scan.descriptions?.[name]).filter((value): value is string => !!value)
    const extra = [...blocks, ...injections, ...recursion]
    if (extra.length) {
      const length = chat.length + extra.reduce((sum, text) => sum + text.length + 2, 0)
      charge(source, "scannedCharacters", length)
      charge(source, "bufferCharacters", length)
    }
    const result = { text: chat + (extra.length ? "\n\x01" + extra.join("\n\x01") : "") }
    buffers.set(id, result)
    return result
  }
  const recursive = (source: (typeof sources)[number]) =>
    source.document.recursive_scanning ?? settings.recursive ?? true
  const scoredGroups = new Set(
    sources.filter((source) => source.entry.use_group_scoring).map((source) => source.entry.group)
  )
  const admittedGroups = new Set<string>()
  const maxSteps = Math.max(1, Math.min(64, settings.maxSteps ?? 16))
  let hardContent = ""
  let charged = ""
  const bookCharged = new Map<string, string>()
  let overflow = false
  const exhaustedBooks = new Set<string>()
  let step = 0
  const skip = (source: (typeof sources)[number], reason: SkipReason) =>
    skipped.set(source, { book: source.book, entry: source.entry, step, reason })
  const activate = () => {
    for (const source of sources) {
      currentSource = source
      const entry = source.entry
      const unsupported: Array<string> = []
      if (entry.group.includes(",")) unsupported.push("overlapping groups (group treated as one name)")
      if (entry.group && entry.group_weight !== 100) unsupported.push("group weights (deterministic choice)")
      if (entry.vectorized || entry.automation_id || /^@@(?:activate|dont_activate)/.test(entry.content))
        unsupported.push("vector/external/decorator activation")
      if (unsupported.length) issue(source, "unsupported", unsupported.join("; "))
    }
    for (; step < maxSteps; step++) {
      buffers.clear()
      const candidates: Array<{ source: (typeof sources)[number]; why: Why; score: number }> = []
      for (const source of sources) {
        currentSource = source
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
        if (!characterFilterPasses(entry.character_filter, scan.speaker)) {
          skip(source, "character_filter")
          continue
        }
        const effect = scan.effects?.get(loreEntryKey(source.book, entry))
        const sticky = effect?.sticky ?? false
        if (effect?.cooldown && !sticky) {
          skip(source, "cooldown")
          continue
        }
        if (entry.delay !== null && entry.delay > (scan.messageCount ?? scan.messages.length)) {
          skip(source, "delay")
          continue
        }
        const delayed = Number(entry.delay_until_recursion)
        if (!sticky && ((delayed && step < delayed) || (step > 0 && (!recursive(source) || entry.exclude_recursion)))) {
          skip(source, "recursion")
          continue
        }
        const scoring = entry.group && (settings.groupScoring || scoredGroups.has(entry.group))
        const text = !entry.constant || scoring ? buffer(source) : { text: "" }
        let why: Why = { kind: entry.constant ? "constant" : sticky ? "sticky" : "constant" }
        const decision = scan.decisions?.get(`${source.book}:${entry.uid}`)
        if (!entry.constant && !sticky && decision !== undefined) {
          why = { kind: "decision", probability: decision }
        } else if (!entry.constant && !sticky) {
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
          const key = primaryKey
          const notes = named.filter((injection) => keyMatch(source, injection.buffer, key, true)).map((i) => i.name)
          why = {
            kind: "keys",
            primaryKey,
            secondaryKeys,
            ...(entry.selective && entry.secondary_keys.length ? { logic: entry.selective_logic } : {}),
            ...(notes.length ? { notes } : {})
          }
        }
        let score = 0
        if (scoring) {
          const primary = entry.keys.filter((key) => keyMatch(source, text, key, false)).length
          const secondary = entry.secondary_keys.filter((key) => keyMatch(source, text, key, false)).length
          score = primary
          if (
            entry.keys.length &&
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
        const stickyMembers = members.filter(
          (m) => scan.effects?.get(loreEntryKey(m.source.book, m.source.entry))?.sticky
        )
        if (stickyMembers.length) {
          // ST retains every sticky member, skips scoring/override, then removes cooldown members.
          for (const member of members)
            if (
              !stickyMembers.includes(member) ||
              scan.effects?.get(loreEntryKey(member.source.book, member.source.entry))?.cooldown
            )
              losers.add(member.source)
          continue
        }
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
      let chargedTokens: number | undefined
      const bookChargedTokens = new Map<string, number>()
      for (const { source, why } of candidates) {
        currentSource = source
        let entry = source.entry
        if (losers.has(source)) {
          skip(source, "group")
          continue
        }
        if ((overflow || exhaustedBooks.has(source.book)) && !entry.ignore_budget) {
          skip(source, "budget")
          continue
        }
        if (
          !scan.effects?.get(loreEntryKey(source.book, entry))?.sticky &&
          entry.use_probability &&
          entry.probability !== 100 &&
          random() * 100 > entry.probability
        ) {
          skip(source, "probability")
          failedProbability.add(source)
          continue
        }
        if (previewContent) {
          if (!previews.has(source)) previews.set(source, previewContent(source))
          const content = previews.get(source)
          if (content === undefined) {
            skip(source, "work_limit")
            issue(source, "work_limit", "Lorebook preview work limit reached; candidate content was left out.")
            continue
          }
          entry = { ...entry, content }
        }
        charge(source, "scannedCharacters", entry.content.length + 1)
        const nextHard = entry.content ? hardContent + (hardContent ? "\n" : "") + entry.content : hardContent
        if (settings.hardBudget !== undefined && nextHard && tokens(source, nextHard) + 3 > settings.hardBudget) {
          skip(source, "budget")
          continue
        }
        const forBook = (newBookContent.get(source.book) ?? "") + entry.content + "\n"
        const bookBudget = source.document.token_budget
        if (!entry.ignore_budget && bookBudget !== null && bookBudget > 0) {
          let previous = bookChargedTokens.get(source.book)
          if (previous === undefined) {
            previous = tokens(source, bookCharged.get(source.book) ?? "")
            bookChargedTokens.set(source.book, previous)
          }
          if (previous + tokens(source, forBook) >= bookBudget) {
            skip(source, "budget")
            exhaustedBooks.add(source.book)
            continue
          }
        }
        newContent += entry.content + "\n"
        newBookContent.set(source.book, forBook)
        if (!entry.ignore_budget) {
          chargedTokens ??= tokens(source, charged)
          if (chargedTokens + tokens(source, newContent) >= settings.budget) {
            skip(source, "budget")
            overflow = true
            continue
          }
        }
        hardContent = nextHard
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
  }
  try {
    const completed = makeRegexDeadline(settings.regexMs ?? 5000).run(activate)
    if (!completed && currentSource) {
      replayable = false
      stopped = "error"
      recordIssue(
        currentSource,
        "regex_timeout",
        "Emergency activation deadline reached; this partial result is not replayable."
      )
    }
  } catch (error) {
    if (error !== halted && currentSource) {
      stopped = "error"
      recordIssue(
        currentSource,
        "evaluation_error",
        `Activation failed: ${String(error).slice(0, 160)}; results are partial.`
      )
    }
  }
  if (stopped) {
    for (const source of sources) {
      const previous = skipped.get(source)
      if (!activated.has(source) && (!previous || previous.step < step || source === currentSource))
        skip(source, stopped)
    }
  }
  return {
    activated: sources.flatMap((source) => activated.get(source) ?? []),
    skipped: sources.flatMap((source) => skipped.get(source) ?? []),
    issues,
    work,
    replayable
  }
}
