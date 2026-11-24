// A unified diff of two texts by line (spec/WORKSHOP-CARDS.md §9 `diff_revisions`), as git shows
// one: hunks headed "@@ -a,n +b,m @@", two lines of context, "-" for a line taken out and "+" for
// one put in. Hunks closer than twice the context join into one.
import { diffIndices } from "node-diff3"

const CONTEXT = 2

export const unifiedDiff = (before: string, after: string): string => {
  const a = before.split("\n")
  const b = after.split("\n")
  const regions = (diffIndices(a, b) as ReadonlyArray<{ buffer1: [number, number]; buffer2: [number, number] }>).map(
    (d) => ({ a: d.buffer1[0], an: d.buffer1[1], b: d.buffer2[0], bn: d.buffer2[1] })
  )
  if (regions.length === 0) return ""
  // Join regions whose context would overlap.
  const groups: Array<Array<(typeof regions)[number]>> = []
  for (const region of regions) {
    const last = groups.at(-1)?.at(-1)
    if (last && region.a - (last.a + last.an) <= CONTEXT * 2) groups.at(-1)!.push(region)
    else groups.push([region])
  }
  const hunks = groups.map((group) => {
    const first = group[0]!
    const last = group.at(-1)!
    const start = Math.max(0, first.a - CONTEXT)
    const end = Math.min(a.length, last.a + last.an + CONTEXT)
    const shift = first.b - first.a
    const lines: Array<string> = []
    let at = start
    for (const region of group) {
      for (; at < region.a; at++) lines.push(` ${a[at]}`)
      for (let i = 0; i < region.an; i++) lines.push(`-${a[region.a + i]}`)
      for (let i = 0; i < region.bn; i++) lines.push(`+${b[region.b + i]}`)
      at = region.a + region.an
    }
    for (; at < end; at++) lines.push(` ${a[at]}`)
    const removed = lines.filter((l) => l[0] !== "+").length
    const added = lines.filter((l) => l[0] !== "-").length
    return [`@@ -${start + 1},${removed} +${start + shift + 1},${added} @@`, ...lines].join("\n")
  })
  return hunks.join("\n")
}
