import type { SearchRequest, SearchResponse } from "./search.ts"

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const preserve = (before: string, after: string) => {
  if (before.toLowerCase() === before.toUpperCase()) return after
  if (before.toUpperCase() === before && before.toLowerCase() !== before) return after.toUpperCase()
  if (before.toLowerCase() === before) return after.toLowerCase()
  if (before[0]?.toUpperCase() === before[0] && before.slice(1).toLowerCase() === before.slice(1))
    return after.charAt(0).toUpperCase() + after.slice(1).toLowerCase()
  return after
}

/** Also used by tests; production calls this only inside the time-limited worker. */
export function searchTexts({
  texts,
  find,
  regex,
  caseSensitive,
  wholeWord,
  preserveCase,
  replace,
  max
}: SearchRequest): SearchResponse {
  let pattern: RegExp
  const source = regex ? find : escape(find)
  const flags = caseSensitive ? "g" : "gi"
  try {
    pattern = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source, flags + "u")
  } catch {
    // Unicode mode rejects escapes plain patterns accept (`\'`, `\-`): those still run without it,
    // with ASCII word boundaries.
    try {
      pattern = new RegExp(wholeWord ? `(?<!\\w)(?:${source})(?!\\w)` : source, flags)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "This isn't a valid pattern." }
    }
  }
  const matches: Array<{ index: number; at: number; length: number; replacement: string | null }> = []
  let total = 0
  const replaced = texts.map((text, index) => {
    pattern.lastIndex = 0
    // matchAll advances empty matches (by code point under `u`).
    const found = text.matchAll(pattern)
    let result = "",
      end = 0
    for (const match of found) {
      const at = match.index
      let replacement = replace
      if (replacement !== null && regex) {
        replacement = replacement.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (token, key: string) => {
          if (key === "$") return "$"
          if (key === "&") return match[0]
          if (key === "`") return text.slice(0, at)
          if (key === "'") return text.slice(at + match[0].length)
          if (key.startsWith("<")) return match.groups ? (match.groups[key.slice(1, -1)] ?? "") : token
          const n = Number(key)
          if (n > 0 && n < match.length) return match[n] ?? ""
          const first = Number(key[0])
          return key.length === 2 && first > 0 && first < match.length ? (match[first] ?? "") + key[1] : token
        })
      }
      if (replacement !== null && preserveCase) replacement = preserve(match[0], replacement)
      if (total++ < max) matches.push({ index, at, length: match[0].length, replacement })
      result += text.slice(end, at) + (replacement ?? match[0])
      end = at + match[0].length
    }
    return result + text.slice(end)
  })
  return { ok: true, matches, truncated: total > max, replaced: replace === null ? null : replaced }
}
