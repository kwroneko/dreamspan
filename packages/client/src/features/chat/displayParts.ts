import type { DisplayTransformV1 } from "../../../../plugin-api/src/display.ts"
import { expandForDisplay } from "./macros.ts"
import { runDisplayRegex } from "./displayRegex.ts"

export const macroDisplayPart = {
  api: 1,
  id: "display.macros",
  order: 10,
  source: import.meta.url,
  transform: (input) => {
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
} satisfies DisplayTransformV1

export const regexDisplayPart = {
  api: 1,
  id: "display.regex",
  order: 20,
  source: import.meta.url,
  transform: (input) => {
    if (
      !input.prefs.displayRegex ||
      !input.scripts.some(
        (script) =>
          !script.disabled &&
          script.find_regex !== "" &&
          script.markdown_only &&
          script.placement.includes(input.placement)
      )
    )
      return { text: input.text, issues: [] }
    return runDisplayRegex(input)
  }
} satisfies DisplayTransformV1
