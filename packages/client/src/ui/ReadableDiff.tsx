// How a setting changed, in words, never as JSON (owner, 2026-11-01): a value becomes lines a
// person reads ("Enabled: on", "3. Main Prompt · on"), and the lines that differ are marked
// removed or added, with the unchanged ones around them. History shows settings this way;
// text keeps the full-text comparison (RevisionDiff).

const isObject = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** `forbid_overrides` → "Forbid overrides", `injectionDepth` → "Injection depth". */
const humanKey = (key: string) => {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A value on one line. */
const inlineValue = (value: unknown): string => {
  if (value === undefined || value === null) return "none"
  if (typeof value === "boolean") return value ? "on" : "off"
  if (typeof value === "string") return value === "" ? "(empty)" : value.replace(/\s+/g, " ")
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map(inlineValue).join(", ")
  if (isObject(value)) {
    const name = value.name ?? value.title ?? value.identifier ?? value.id
    const rest = Object.entries(value).filter(([key]) => !["name", "title", "identifier", "id"].includes(key))
    const parts = rest.map(([key, inner]) => `${humanKey(key)}: ${inlineValue(inner)}`)
    return [typeof name === "string" && name !== "" ? name : null, ...parts].filter((p) => p !== null).join(" · ")
  }
  return String(value)
}

/** A value as lines: a list's elements numbered, an object's keys one per line. */
export const readableLines = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value))
    return value.length === 0 ? ["None"] : value.map((item, i) => `${i + 1}. ${inlineValue(item)}`)
  if (isObject(value)) {
    const entries = Object.entries(value)
    return entries.length === 0 ? ["None"] : entries.map(([key, inner]) => `${humanKey(key)}: ${inlineValue(inner)}`)
  }
  return [inlineValue(value).replace(/^./, (c) => c.toUpperCase())]
}

type Line = { readonly kind: "same" | "removed" | "added"; readonly text: string }

/** Lines of `a` and `b` matched by their longest common run; past a size, all removed then added. */
const lineDiff = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): ReadonlyArray<Line> => {
  if (a.length * b.length > 1_000_000)
    return [
      ...a.map((text) => ({ kind: "removed" as const, text })),
      ...b.map((text) => ({ kind: "added" as const, text }))
    ]
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const out: Array<Line> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push({ kind: "removed", text: a[i++]! })
    else out.push({ kind: "added", text: b[j++]! })
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++]! })
  while (j < b.length) out.push({ kind: "added", text: b[j++]! })
  return out
}

/** Unchanged lines kept on each side of a change; the rest fold to "…". */
const CONTEXT = 2

export function ReadableDiff({
  before,
  after,
  lines = readableLines
}: {
  before: unknown
  after: unknown
  /** How a value reads; a feature can name things the generic reading can't (a prompt's name). */
  lines?: (value: unknown) => ReadonlyArray<string>
}) {
  const diff = lineDiff(before === undefined ? [] : lines(before), after === undefined ? [] : lines(after))
  const near = diff.map((_, index) =>
    diff.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some((line) => line.kind !== "same")
  )
  return (
    <ul aria-label="Changed settings" className="flex flex-col rounded-md border border-border bg-canvas p-2 text-sm">
      {diff.map((line, index) =>
        near[index] ? (
          <li
            key={index}
            className={`[overflow-wrap:anywhere] ${
              line.kind === "removed"
                ? "bg-danger/10 text-danger"
                : line.kind === "added"
                  ? "bg-success/10 text-success"
                  : "text-muted"
            }`}
          >
            <span aria-hidden="true" className="inline-block w-4 select-none">
              {line.kind === "removed" ? "−" : line.kind === "added" ? "+" : ""}
            </span>
            {line.kind === "removed" ? (
              <del aria-label="Removed" className="no-underline">
                {line.text}
              </del>
            ) : line.kind === "added" ? (
              <ins aria-label="Added" className="no-underline">
                {line.text}
              </ins>
            ) : (
              line.text
            )}
          </li>
        ) : near[index - 1] ? (
          <li key={index} aria-hidden="true" className="text-muted">
            …
          </li>
        ) : null
      )}
    </ul>
  )
}
