// Run with node packages/server/scripts/cache-study.ts > /outside-checkout/results.json
import { studyRequests, compareCaches } from "../test/support/cacheStudy.ts"
const requests = await studyRequests()
const rows = compareCaches(requests)
const volatility = []
for (const macro of [
  "{{roll::1d1000000}}",
  "{{random::one::two::three::four}}",
  "{{time}}",
  "{{date}}",
  "{{isotime}}",
  "{{pick::one::two}}"
]) {
  const sequence = await studyRequests(macro, 4, 3)
  volatility.push({
    macro,
    warned: sequence[0]!.snapshot.issues.some((i) => i.kind === "cache_breakpoints"),
    rows: compareCaches(sequence).filter((r) => r.layout === "recommended")
  })
}
const depths = []
for (const depth of [1, 2, 3]) depths.push({ depth, rows: compareCaches(await studyRequests("", depth, 6)) })
console.log(
  JSON.stringify(
    {
      requests: requests.length,
      historyMoves: requests
        .filter((r) => r.group !== "swipe")
        .map((r) => ({
          group: r.group,
          move: r.snapshot.historyMove,
          start: r.snapshot.historyStart?.depth,
          input: r.blocks.reduce((n, b) => n + b.tokens, 0)
        })),
      rows,
      volatility,
      depths
    },
    null,
    2
  )
)
