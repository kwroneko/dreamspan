// ST's variable macros (public/scripts/macros/definitions/variable-macros.js at 06bde939).
// Writes go to the expansion's variables and come back as effects.
import type { MacroCall, MacroSpec } from "../registry.ts"
import { normalize, type VarScope } from "../variables.ts"

const name = { name: "name" } as const
const value = { name: "value", type: ["string", "number"] } as const
const key = { name: "key", type: ["string", "number"] } as const

const scope = (call: MacroCall, which: VarScope) => call.variables[which]

const family = (which: VarScope, infix: "" | "global"): ReadonlyArray<MacroSpec> => [
  {
    name: `set${infix}var`,
    args: [name, value],
    handler: (call) => {
      scope(call, which).set(call.args[0]!, call.args[1]!)
      return ""
    }
  },
  {
    name: `add${infix}var`,
    args: [name, value],
    handler: (call) => {
      scope(call, which).add(call.args[0]!, call.args[1]!)
      return ""
    }
  },
  { name: `inc${infix}var`, args: [name], handler: (call) => scope(call, which).add(call.args[0]!, 1) },
  { name: `dec${infix}var`, args: [name], handler: (call) => scope(call, which).add(call.args[0]!, -1) },
  { name: `get${infix}var`, args: [name], handler: (call) => normalize(scope(call, which).get(call.args[0]!)) },
  {
    name: `has${infix}var`,
    aliases: [`${infix}varexists`],
    args: [name],
    handler: (call) => String(scope(call, which).has(call.args[0]!))
  },
  {
    name: `delete${infix}var`,
    aliases: [`flush${infix}var`],
    args: [name],
    handler: (call) => {
      scope(call, which).delete(call.args[0]!)
      return ""
    }
  },
  {
    name: `set${infix}varkey`,
    aliases: [`set${infix}varindex`],
    args: [name, key, value],
    handler: (call) => {
      scope(call, which).setAt(call.args[0]!, call.args[1]!, call.args[2]!)
      return ""
    }
  },
  {
    name: `get${infix}varkey`,
    aliases: [`get${infix}varindex`],
    args: [name, key],
    handler: (call) => normalize(scope(call, which).getAt(call.args[0]!, call.args[1]!))
  }
]

export const variableMacros: ReadonlyArray<MacroSpec> = [...family("local", ""), ...family("global", "global")]
