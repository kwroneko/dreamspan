import type { Version } from "@rp/shared/chat.ts"
import type { DisplayPrefs } from "@rp/shared/chatApi.ts"
import type { RegexScript } from "@rp/shared/docs/preset.ts"
import type { CardFields } from "@rp/shared/macros/context.ts"
import { makeRegistry } from "../../registry.ts"
import { expandForDisplay, type DisplayNames } from "./macros.ts"

export interface DisplayInput {
  readonly text: string
  readonly version: Version
  readonly names: DisplayNames
  readonly card: CardFields
  readonly prefs: DisplayPrefs
  readonly scripts: ReadonlyArray<RegexScript>
  readonly placement: 1 | 2
  readonly depth: number | null
}
export interface DisplayResult {
  readonly text: string
  readonly issues: ReadonlyArray<string>
}
export const displayTransforms = makeRegistry<{
  readonly id: string
  readonly order: number
  readonly transform: (input: DisplayInput) => Promise<DisplayResult> | DisplayResult
}>()

export const applyDisplayTransforms = async (
  input: DisplayInput,
  stages = displayTransforms.list()
): Promise<DisplayResult> => {
  let text = input.text
  const issues: string[] = []
  for (const stage of [...stages].sort((a, b) => a.order - b.order).slice(0, 20)) {
    try {
      const result = await stage.transform({ ...input, text })
      if (result.text.length > 1_000_000) throw new Error("output limit")
      text = result.text
      issues.push(...result.issues.slice(0, 100))
    } catch {
      issues.push("A display transformation failed; its input is shown.")
    }
  }
  return { text, issues }
}

export const macroDisplay = (input: DisplayInput): DisplayResult => {
  const result = expandForDisplay(
    input.text,
    input.version.macroMode,
    input.names,
    input.card,
    input.version.frozenMacros ?? {},
    input.version.writer === "model" && input.prefs.outputMacros
  )
  return { text: result.text, issues: result.issue ? [result.issue] : [] }
}
