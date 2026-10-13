// Loaded only by the crash regression's child. Kill the real writer after commit, before RPC acknowledgement.
import { registerHooks } from "node:module"
registerHooks({
  load(url, context, next) {
    const result = next(url, context)
    if (!url.endsWith("/db/lcmQueue.ts")) return result
    const source = String(result.source)
    const boundary = '}).pipe(transaction(sql, "ClaimSummaryJob"))'
    if (!source.includes(boundary)) throw new Error("Claim fault point moved")
    return {
      ...result,
      source: source.replace(
        boundary,
        boundary.slice(0, -1) +
          ", Effect.tap(job => job && job.epoch === 1 ? Effect.sync(() => process.exit(91)) : Effect.void))"
      )
    }
  }
})
