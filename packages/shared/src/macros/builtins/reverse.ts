import type { DataMacroSpec } from "../../../../plugin-api/src/macros.ts"

/** Reverse Unicode code points, preserving the built-in macro's behaviour. */
export const reverseMacro: DataMacroSpec = {
  source: import.meta.url,
  kind: "directive",
  name: "reverse",
  args: [{ name: "value" }],
  handler: (call) => Array.from(call.args[0]!).reverse().join("")
}
