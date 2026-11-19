import { WORKSHOP_SUMMARY_INSTRUCTION } from "@dreamspan/shared/workshopLcm.ts"
import { summaryWords } from "@dreamspan/shared/lcmSettings.ts"
import type { ContextSnapshot } from "../assembler/types.ts"

export interface SummaryInstruction {
  readonly id: string
  readonly render: (input: {
    readonly job: NonNullable<ContextSnapshot["summaryJob"]>
    readonly target: number
    readonly range?: { readonly from: number; readonly to: number }
  }) => string
}
export interface SummaryStyleSelector {
  readonly id: string
  readonly select: (style: string | undefined) => string
}
export const defaultSummaryStyle: SummaryStyleSelector = { id: "settings", select: (style) => style ?? "direct" }
export const leafInstruction: SummaryInstruction = { id: "leaf", render: ({ job }) => job.tail }
/** Workshop framing and the user's instruction are a replaceable summary policy. */
export const workshopInstruction: SummaryInstruction = {
  id: "workshop",
  render: ({ job }) =>
    WORKSHOP_SUMMARY_INSTRUCTION +
    (job.tail === WORKSHOP_SUMMARY_INSTRUCTION ? "" : `\nUser's summary preference: ${job.tail}`)
}
export const condensationInstruction: SummaryInstruction = {
  id: "condensation",
  render: ({ job, target, range: span }) => {
    const count = job.children?.length ?? 0
    const range = span ? `(messages ${span.from} to ${span.to})` : ""
    return job.withPreset === false
      ? `Condense the last ${count} summaries ${range} into one summary of at most ${summaryWords(target)} words. Keep their language and voice, names, events and unresolved details. Any summaries before them are continuity, not material to condense again.`
      : `Condense the last ${count} summaries above ${range} into one summary of at most ${summaryWords(target)} words. Keep its language and voice, names, events and unresolved details. The earlier summaries are continuity, not material to condense again.`
  }
}
