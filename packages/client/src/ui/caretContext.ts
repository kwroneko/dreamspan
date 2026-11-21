// A point in a message's rendered text, found again in its stored text by the words around it.
// The rendered text differs from the stored one (markdown marks, display regex, macros, HTML),
// so only letters and digits are compared: a run of them either side of the point, as long as
// it is found, at the occurrence nearest the point's proportional place in the text.

/** Letters and digits: what rendering keeps of the text, mostly. */
const WORD = /^[\p{L}\p{N}]$/u

interface Skeleton {
  /** The text's letters and digits, in order. */
  readonly chars: string
  /** For each UTF-16 unit of `chars`, the offset in the text of its character. */
  readonly at: ReadonlyArray<number>
  /** For each UTF-16 unit of `chars`, the offset just past its character. */
  readonly end: ReadonlyArray<number>
}

function skeleton(text: string): Skeleton {
  let chars = ""
  const at: number[] = []
  const end: number[] = []
  let offset = 0
  for (const char of text) {
    if (WORD.test(char)) {
      chars += char
      for (let unit = 0; unit < char.length; unit++) {
        at.push(offset)
        end.push(offset + char.length)
      }
    }
    offset += char.length
  }
  return { chars, at, end }
}

/** Every index of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = []
  for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + 1)) found.push(from)
  return found
}

/** Context lengths tried, in letters each side: the longest found wins. */
const SPANS = [48, 24, 12, 6, 3] as const

/**
 * The offset in `source` of the point between `before` and `after`, the rendered text either
 * side of it. Among several matches, the one nearest the point's proportional place; with no
 * match even for a few letters, the start of the clicked word where it appears nearest, else
 * the start of the nearest paragraph.
 */
export function contextOffset(source: string, before: string, after: string): number {
  if (source === "") return 0
  const rendered = before.length + after.length
  const target = rendered === 0 ? source.length : (before.length / rendered) * source.length
  const text = skeleton(source)
  const left = skeleton(before).chars
  const right = skeleton(after).chars
  // Whether the point touches a letter on that side, so the caret goes right next to it.
  const touchesLeft = before.length > 0 && WORD.test(lastChar(before))
  const touchesRight = after.length > 0 && WORD.test(firstChar(after))
  /** The source offset where the point falls, for a match of `l` letters left of it at `index`. */
  const offsetAt = (index: number, l: number) => {
    const join = index + l
    if (l > 0 && (touchesLeft || !touchesRight || join >= text.chars.length)) return text.end[join - 1]!
    return join < text.chars.length ? text.at[join]! : source.length
  }
  const nearest = (candidates: ReadonlyArray<number>) =>
    candidates.reduce((best, offset) => (Math.abs(offset - target) < Math.abs(best - target) ? offset : best))
  for (const span of SPANS) {
    const l = left.slice(-span)
    const r = right.slice(0, span)
    // Both sides first; then one side, where the other has text the source doesn't (a macro's value).
    const tries: Array<[string, number]> = [[l + r, l.length]]
    if (r.length > 0) tries.push([right.slice(0, 2 * span), 0])
    if (l.length > 0) tries.push([left.slice(-2 * span), Math.min(left.length, 2 * span)])
    for (const [needle, leftLength] of tries) {
      if (needle.length < 3) continue
      const found = occurrences(text.chars, needle)
      if (found.length > 0) return nearest(found.map((index) => offsetAt(index, leftLength)))
    }
  }
  // The clicked word, wherever the source has it whole.
  const wordLeft = touchesLeft ? (/[\p{L}\p{N}]+$/u.exec(before)?.[0] ?? "") : ""
  const wordRight = touchesRight ? (/^[\p{L}\p{N}]+/u.exec(after)?.[0] ?? "") : ""
  const word = wordLeft + wordRight
  if (word.length > 0) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const whole = [...source.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"))]
    if (whole.length > 0) return nearest(whole.map((match) => match.index + wordLeft.length))
  }
  // The paragraph nearest its place.
  const starts = [0, ...[...source.matchAll(/\n\s*\n/g)].map((match) => match.index + match[0].length)]
  return nearest(
    starts.filter((start) => start <= target).length > 0 ? starts.filter((start) => start <= target) : starts
  )
}

const lastChar = (text: string) => [...text.slice(-2)].at(-1) ?? ""
const firstChar = (text: string) => [...text.slice(0, 2)][0] ?? ""
