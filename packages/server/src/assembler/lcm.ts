import { Effect } from "effect"
import type { Summary } from "@rp/shared/lcm.ts"
import { resolveLcm } from "@rp/shared/lcmSettings.ts"
import { AssemblySources, need, type AssemblerStage } from "./pipeline.ts"
import { historyLeafOf } from "./types.ts"
import { layerKnown } from "./knowledge.ts"

/** One summary as its own message's text (DESIGN §8: separate blocks placed like the history). */
export const summaryBlock = (s: Pick<Summary, "level" | "from" | "to" | "content">) =>
  `<summary level="${s.level}" from="${s.from}" to="${s.to}">\n${s.content}\n</summary>`

export const lcmStage: AssemblerStage = {
  id: "lcm",
  run: (assembly) =>
    Effect.gen(function* () {
      // A rewrite (a text through its scripts, as a reply streams) uses no summaries.
      if (!need(assembly, "state").lcm?.enabled || assembly.request.rewrite) return assembly
      const sources = yield* AssemblySources
      assembly.lcmSettings = resolveLcm(
        need(assembly, "state").lcm,
        sources.lcmDefaults ? yield* sources.lcmDefaults() : null
      )
      const leaf = historyLeafOf(need(assembly, "target"))
      const layer = yield* sources.summaryLayer(leaf)
      // A separate context: summaries covering what the speaker missed are withheld until
      // summaries are kept per view (spec/CHARACTER-CONTEXT.md §9.2 C7).
      if (
        layer.cursor !== null &&
        ((assembly.knowledge?.viewer != null && layer.summaries.some((s) => !s.fresh)) ||
          !(yield* layerKnown(assembly, leaf, layer.cursorDepth)))
      ) {
        assembly.issues.push({
          kind: "summaries_withheld",
          message:
            "Summaries aren't used for this reply: they cover messages its speaker wasn't present for, or their earlier inputs can no longer be verified. The messages it was present for are sent instead, as far as they fit."
        })
        return assembly
      }
      assembly.lcm = layer
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
