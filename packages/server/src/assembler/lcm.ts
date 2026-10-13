import { Effect } from "effect"
import type { Summary } from "@rp/shared/lcm.ts"
import { AssemblySources, need, type AssemblerStage } from "./pipeline.ts"

export const layerText = (summaries: ReadonlyArray<Summary>, st: boolean) => {
  const visible = summaries.filter((s) => s.content !== "")
  if (!visible.length) return ""
  return st
    ? visible.map((s) => s.content).join("\n\n")
    : `<summaries>\n${visible.map((s) => `<summary level="${s.level}" from="${s.from}" to="${s.to}">\n${s.content}\n</summary>`).join("\n")}\n</summaries>`
}

export const lcmStage: AssemblerStage = {
  id: "lcm",
  run: (assembly) =>
    Effect.gen(function* () {
      if (!need(assembly, "state").lcm?.enabled) return assembly
      const sources = yield* AssemblySources
      assembly.lcm = yield* sources.summaryLayer(need(assembly, "target").parentSlotId)
      assembly.lcmPieces = assembly.lcm.summaries.map((summary) => {
        assembly.pieces.push({
          id: `summary:${summary.firstSlotId}:${summary.lastSlotId}`,
          source: {
            kind: "summary",
            id: summary.id,
            revision: summary.revisionId,
            revisionNumber: summary.revisionNumber,
            level: summary.level,
            from: summary.from,
            to: summary.to,
            stale: !summary.fresh
          },
          text: summary.content,
          messages: []
        })
        return assembly.pieces.length - 1
      })
      return assembly
    })
}
