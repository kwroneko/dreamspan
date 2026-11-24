// A synthetic summary style registered the way a part registers one (ExecutionRegistry.summaries),
// for browser tests of the "Written as" picker: `FAKE_SUMMARY_STYLE=on` adds `synthetic/notes`,
// which writes like "A reply" under its own name.
import { Effect, Layer } from "effect"
import { ExecutionRegistry } from "../execution.ts"
import { directSummary } from "../lcm/strategies.ts"

const FAKE_SUMMARY_STYLE_ID = "synthetic/notes"

/** Whether a `FAKE_SUMMARY_STYLE` value asks for it. */
export const fakeSummaryStyleWanted = (value: string | undefined) => value === "on"

/** Adds the style to the server it's provided over. */
export const fakeSummaryStyle = Layer.effectDiscard(
  Effect.flatMap(ExecutionRegistry, (execution) =>
    execution.summaries.register({
      ...directSummary,
      id: FAKE_SUMMARY_STYLE_ID,
      label: "Story notes",
      description: "Writes the summary as short story notes."
    })
  )
)
