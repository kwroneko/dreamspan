// ST's variable macros (public/scripts/macros/definitions/variable-macros.js at 06bde939).
// Writes go to the expansion's variables and come back as effects.
import type { MacroCall, MacroSpec } from "../registry.ts"
import { normalize, type VarScope } from "../variables.ts"

const name = { name: "name" } as const
const value = { name: "value" } as const
const key = { name: "key" } as const

const scope = (call: MacroCall, which: VarScope) => call.variables[which]

const family = (which: VarScope, infix: "" | "global"): ReadonlyArray<MacroSpec> => [
  {
    kind: "directive",
    name: `set${infix}var`,
    args: [name, value],
    handler: (call) => {
      scope(call, which).set(call.args[0]!, call.args[1]!)
      return ""
    }
  },
  {
    kind: "directive",
    name: `add${infix}var`,
    args: [name, value],
    handler: (call) => {
      scope(call, which).add(call.args[0]!, call.args[1]!)
      return ""
    }
  },
  {
    kind: "directive",
    name: `inc${infix}var`,
    args: [name],
    handler: (call) => scope(call, which).add(call.args[0]!, 1)
  },
  {
    kind: "directive",
    name: `dec${infix}var`,
    args: [name],
    handler: (call) => scope(call, which).add(call.args[0]!, -1)
  },
  {
    kind: "value",
    name: `get${infix}var`,
    args: [name],
    handler: (call) => normalize(scope(call, which).get(call.args[0]!))
  },
  {
    kind: "value",
    name: `has${infix}var`,
    aliases: [`${infix}varexists`],
    args: [name],
    handler: (call) => String(scope(call, which).has(call.args[0]!))
  },
  {
    kind: "directive",
    name: `delete${infix}var`,
    aliases: [`flush${infix}var`],
    args: [name],
    handler: (call) => {
      scope(call, which).delete(call.args[0]!)
      return ""
    }
  },
  {
    kind: "directive",
    name: `set${infix}varkey`,
    aliases: [`set${infix}varindex`],
    args: [name, key, value],
    handler: (call) => {
      scope(call, which).setAt(call.args[0]!, call.args[1]!, call.args[2]!)
      return ""
    }
  },
  {
    kind: "value",
    name: `get${infix}varkey`,
    aliases: [`get${infix}varindex`],
    args: [name, key],
    handler: (call) => normalize(scope(call, which).getAt(call.args[0]!, call.args[1]!))
  }
]

export const variableMacros: ReadonlyArray<MacroSpec> = [...family("local", ""), ...family("global", "global")]
