import { Effect } from "effect"
import type { Summary } from "@rp/shared/lcm.ts"
import { resolveLcm } from "@rp/shared/lcmSettings.ts"
import { AssemblySources, need, type AssemblerStage } from "./pipeline.ts"
import { historyLeafOf } from "./types.ts"

/** One summary as its own message's text (DESIGN §8: separate blocks placed like the history). */
export const summaryBlock = (s: Pick<Summary, "level" | "from" | "to" | "content">) =>
  `<summary level="${s.level}" from="${s.from}" to="${s.to}">\n${s.content}\n</summary>`

export const lcmStage: AssemblerStage = {
  id: "lcm",
  run: (assembly) =>
    Effect.gen(function* () {
      if (!need(assembly, "state").lcm?.enabled) return assembly
      const sources = yield* AssemblySources
      assembly.lcmSettings = resolveLcm(
        need(assembly, "state").lcm,
        sources.lcmDefaults ? yield* sources.lcmDefaults() : null
      )
      assembly.lcm = yield* sources.summaryLayer(historyLeafOf(need(assembly, "target")))
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
      const ranges: Array<{ from: number; to: number }> = []
      for (const failure of assembly.lcm.failures ?? []) {
        const last = ranges.at(-1)
        if (last && failure.from <= last.to) last.to = Math.max(last.to, failure.to)
        else ranges.push({ from: failure.from, to: failure.to })
      }
      assembly.lcmFailurePieces = ranges.map((range) => {
        const piece = assembly.pieces.length
        assembly.pieces.push({
          id: `lcm:failed:${range.from}:${range.to}`,
          source: { kind: "assembler", what: "Failed summary" },
          text: `[Messages ${range.from}–${range.to} could not be summarized.]`,
          messages: []
        })
        return { ...range, piece }
      })
      return assembly
    })
}
