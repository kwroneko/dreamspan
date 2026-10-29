// ST capture replacement semantics shared by bounded prompt and display runners.
/** Thrown from a replacement once the scripts have made all the text they may. */
export class OutputLimit extends Error {}

/**
 * ST's runRegexScript, its replacement already expanded, the text it makes charged to `output`.
 * It loops over `exec` because V8's `replace` can hang where no timeout reaches (§15).
 */
export const run = (
  regex: RegExp,
  replacement: string,
  trimStrings: ReadonlyArray<string>,
  text: string,
  output: { left: number } = { left: Number.POSITIVE_INFINITY }
) => {
  const template = replacement.replace(/{{match}}/gi, "$0")
  const replace = (match: RegExpExecArray) => {
    // What a replace function gets: the match, its groups, its offset and the text.
    const args: ReadonlyArray<unknown> = [...match, match.index, text]
    const tokens = /\$(\d+)|\$<([^>]+)>/g
    let made = ""
    let from = 0
    const append = (value: string) => {
      // Charge before joining: a capture repeated many times must never allocate the
      // expanded replacement before discovering that it exceeds the output budget.
      charge(value.length)
      made += value
    }
    for (;;) {
      const token = tokens.exec(template)
      if (!token) break
      append(template.slice(from, token.index))
      const value = token[1] ? args[Number(token[1])] : token[2] ? match.groups?.[token[2]] : undefined
      if (typeof value === "string" && value) append(trimStrings.reduce((s, trim) => s.replaceAll(trim, ""), value))
      from = token.index + token[0].length
    }
    append(template.slice(from))
    return made
  }
  const charge = (length: number) => {
    output.left -= length
    if (output.left < 0) throw new OutputLimit()
  }
  regex.lastIndex = 0
  let result = ""
  let copied = 0
  let matched = false
  for (;;) {
    const match = regex.exec(text)
    if (match === null) break
    matched = true
    const made = replace(match)
    charge(match.index - copied)
    result += text.slice(copied, match.index) + made
    copied = match.index + match[0].length
    if (!regex.global) break
    if (match[0] === "") {
      const at = regex.lastIndex
      const first = text.charCodeAt(at),
        second = text.charCodeAt(at + 1)
      const pair =
        (regex.unicode || regex.unicodeSets) &&
        first >= 0xd800 &&
        first <= 0xdbff &&
        second >= 0xdc00 &&
        second <= 0xdfff
      regex.lastIndex += pair ? 2 : 1
    }
  }
  // Without a match the text is returned as it is, and nothing is made.
  if (!matched) return text
  charge(text.length - copied)
  return result + text.slice(copied)
}
