// The harness's report: one section per comparison, every difference on its own line.

export interface Section {
  readonly title: string
  /** What the comparison ran on, for context. */
  readonly notes: ReadonlyArray<string>
  readonly differences: ReadonlyArray<string>
  /** Why these differences are expected: they're listed, but don't fail the run. */
  readonly expected?: string
}

const MAX_TEXT = 160

/** A value as one line of JSON, long text cut in the middle so both ends show. */
const show = (value: unknown) => {
  const text = value === undefined ? "(absent)" : JSON.stringify(value)
  if (text.length <= MAX_TEXT) return text
  const half = Math.floor((MAX_TEXT - 5) / 2)
  return `${text.slice(0, half)} ... ${text.slice(-half)}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Every place two JSON values differ, as `path: left ≠ right`. Objects are compared key by
 * key and arrays index by index, so a missing message shows as `(absent)` on one side.
 */
export const diffJson = (left: unknown, right: unknown, path = ""): Array<string> => {
  if (Array.isArray(left) && Array.isArray(right)) {
    return Array.from({ length: Math.max(left.length, right.length) }, (_, i) =>
      diffJson(left[i], right[i], `${path}[${i}]`)
    ).flat()
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    return keys.flatMap((key) => diffJson(left[key], right[key], path === "" ? key : `${path}.${key}`))
  }
  if (Object.is(left, right)) return []
  return [`${path || "(root)"}: ${show(left)} ≠ ${show(right)}`]
}

/** Prints the report and returns how many unexpected differences it lists. */
export const printReport = (sections: ReadonlyArray<Section>) => {
  let total = 0
  for (const section of sections) {
    const count = section.differences.length
    if (section.expected === undefined) total += count
    const expected = section.expected === undefined || count === 0 ? "" : ` (expected: ${section.expected})`
    console.log(`\n== ${section.title}: ${count === 0 ? "same" : `${count} differences`}${expected}`)
    for (const note of section.notes) console.log(`   ${note}`)
    for (const difference of section.differences) console.log(` - ${difference}`)
  }
  console.log(`\n${total === 0 ? "No unexpected differences." : `${total} unexpected differences.`}`)
  return total
}
