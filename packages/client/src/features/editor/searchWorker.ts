// The editor's search and replace, in a worker of its own (ARCHITECTURE.md §14.6). A user's
// regular expression can backtrack for minutes on the wrong text; here it can only stall
// this worker, which the page stops after a time limit.
import type { SearchRequest, SearchResponse } from "./search.ts"

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null
  postMessage: (message: SearchResponse) => void
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const run = ({ texts, find, regex, caseSensitive, replace, max }: SearchRequest): SearchResponse => {
  let pattern: RegExp
  try {
    pattern = new RegExp(regex ? find : escape(find), caseSensitive ? "g" : "gi")
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "This isn't a valid pattern." }
  }
  const matches: Array<{ index: number; at: number; length: number }> = []
  let truncated = false
  texts.forEach((text, index) => {
    pattern.lastIndex = 0
    for (let match = pattern.exec(text); match !== null && !truncated; match = pattern.exec(text)) {
      // An empty match would find itself again forever.
      if (match[0].length === 0) pattern.lastIndex++
      if (matches.length === max) truncated = true
      else matches.push({ index, at: match.index, length: match[0].length })
    }
  })
  const replaced =
    replace === null
      ? null
      : texts.map((text) => {
          pattern.lastIndex = 0
          // Plain text replaces literally; a pattern's replacement can use $1 and the like.
          return regex ? text.replace(pattern, replace) : text.replace(pattern, () => replace)
        })
  return { ok: true, matches, truncated, replaced }
}

scope.onmessage = (event) => scope.postMessage(run(event.data))
