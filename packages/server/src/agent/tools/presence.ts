// Built-in and copied policy share exactly the same storage/causal adapter.
import type { RolloutTool } from "../tools.ts"
import { safely } from "./history.ts"
import { presencePart } from "./presencePart.ts"
import { presenceContext } from "./presenceAdapter.ts"

export const setPresence: RolloutTool<{ readonly character: string; readonly present: boolean }> = {
  ...presencePart,
  parameters: presencePart.parameters as RolloutTool["parameters"],
  execute: (context, args) => safely("set_presence", presencePart.execute(presenceContext(context), args))
}
