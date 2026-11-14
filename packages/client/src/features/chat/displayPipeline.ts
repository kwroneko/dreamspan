import type { Version } from "@rp/shared/chat.ts"
import type { DisplayPrefs } from "@rp/shared/chatApi.ts"
import type { RegexScript } from "@rp/shared/docs/preset.ts"
import type { CardFields } from "@rp/shared/macros/context.ts"
import { makeRegistry } from "../../registry.ts"
import type { DisplayNames } from "./macros.ts"
import { macroDisplayPart } from "./displayParts.ts"

export interface DisplayInput {
  readonly text: string
  readonly version: Version
  readonly names: DisplayNames
  readonly card: CardFields
  readonly prefs: DisplayPrefs
  readonly scripts: ReadonlyArray<RegexScript>
  /** ST's placement: 1 user input, 2 AI output, 6 reasoning. */
  readonly placement: 1 | 2 | 6
  readonly depth: number | null
  readonly streaming?: boolean
}
export interface DisplayResult {
  readonly text: string
  readonly issues: ReadonlyArray<string>
}
export const displayTransforms = makeRegistry<{
  readonly id: string
  readonly order: number
  readonly source?: string
  readonly replacement?: string
  /** Worker rules need the positional fields even when the built-in switches are off. */
  readonly needsContext?: boolean
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

export const macroDisplay = macroDisplayPart.transform
