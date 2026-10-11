// ST's core macros (public/scripts/macros/definitions/core-macros.js at 06bde939): text
// utilities, control flow, randomness. ST's `{{banned}}` (a text-completion ban list) is
// kept only so it's stripped from prompts, as ST strips it for chat completion.
import { ELSE_MARKER, isFalse, trimScoped } from "../engine.ts"
import { stringHash } from "../hash.ts"
import type { MacroCall, MacroSpec } from "../registry.ts"

const count = { name: "count", optional: true, type: "integer" } as const

const COMMA = "##�COMMA�##"

/** ST's readSingleArgsRandomList: `{{random a,b}}` and `{{random:a::b}}` pass the list as one argument. */
const choices = (list: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (list.length !== 1) return list
  const single = list[0]!
  if (single.includes("::")) return single.split("::").map((item) => item.trim())
  return single
    .replace(/\\,/g, COMMA)
    .split(",")
    .map((item) => item.trim().replaceAll(COMMA, ","))
}

const DICE = /^([1-9]\d*)?d([1-9]\d*)([+-]\d+)?$/i

/** ST's droll formulas: `NdS±M`, or a bare number of sides. An invalid formula rolls "". */
const roll = (call: MacroCall) => {
  const formula = /^\d+$/.test(call.args[0]!) ? `1d${call.args[0]}` : call.args[0]!
  const m = DICE.exec(formula)
  if (!m) return ""
  const dice = Number(m[1] ?? 1)
  const sides = Number(m[2])
  call.charge(dice)
  let total = Number(m[3] ?? 0)
  for (let i = 0; i < dice; i++) total += 1 + Math.floor(call.random() * sides)
  return String(total)
}

const SHORTHAND = /^([.$])([a-zA-Z](?:[\w-]*\w)?)$/

/** ST's splitOnTopLevelElse: the first `{{else}}` outside nested scoped `{{if}}`s. */
const splitOnElse = (call: MacroCall, content: string): readonly [string, string | undefined] => {
  let depth = 0
  for (const macro of call.macrosIn(content)) {
    // ST compares these names case-sensitively, unlike scoped pairing.
    if (macro.name === "if" && !macro.closing && macro.argCount === 1) depth++
    else if (macro.name === "if" && macro.closing) depth--
    else if (macro.name === "else" && depth === 0) return [content.slice(0, macro.start), content.slice(macro.end)]
  }
  return [content, undefined]
}

/**
 * `{{if condition}}then{{else}}otherwise{{/if}}`. Only the chosen branch is expanded. The
 * condition is falsy when empty, "false", "off" or "0"; a leading "!" inverts it. A
 * condition that names a macro taking no arguments (`{{if description}}`) or a variable
 * (`{{if .flag}}`) is resolved first.
 */
const conditional = (call: MacroCall) => {
  const [rawCondition = "", content = ""] = call.args
  const inverted = /^\s*!/.test(rawCondition)
  let condition = call.resolve(inverted ? rawCondition.replace(/^\s*!\s*/, "") : rawCondition)
  const shorthand = SHORTHAND.exec(condition)
  if (shorthand) condition = call.resolve(`{{${shorthand[1] === "." ? "getvar" : "getglobalvar"}::${shorthand[2]}}}`)
  else if (call.lookup(condition)?.minArgs === 0) condition = call.resolve(`{{${condition}}}`)
  const falsy = (condition === "" || isFalse(condition)) !== inverted
  const [then, otherwise] = splitOnElse(call, content)
  const branch = falsy ? otherwise : then
  if (branch === undefined) return ""
  const result = call.resolve(branch)
  return call.flags.includes("#") ? result : trimScoped(result)
}

const pick = (call: MacroCall) => {
  const items = choices(call.list)
  if (items.length === 0) return ""
  // ST seeds with the chat id, the text and the position; it uses seedrandom, so the
  // pick for a given seed differs from ST's.
  const { pickSeed } = call.context
  const seed = [pickSeed === undefined ? [] : [stringHash(pickSeed)], call.contentHash, call.offset].flat().join("-")
  return items[Math.floor((stringHash(seed) / 2 ** 53) * items.length)]!
}

const repeat = (call: MacroCall, text: string) => {
  const n = Number(call.args[0] ?? 1)
  call.charge(n)
  return text.repeat(n)
}

const tokens = (value: number | undefined) => (value === undefined ? "" : String(value))

export const utilityMacros: ReadonlyArray<MacroSpec> = [
  { name: "space", args: [count], handler: (call) => repeat(call, " ") },
  { name: "newline", args: [count], handler: (call) => repeat(call, "\n") },
  { name: "noop", handler: () => "" },
  {
    // Inline, it's removed with the newlines around it after evaluation; scoped, its block
    // is trimmed like any block.
    name: "trim",
    args: [{ name: "content", optional: true }],
    handler: (call) => (call.isScoped ? (call.args[0] ?? "") : "{{trim}}")
  },
  {
    name: "if",
    args: [{ name: "condition" }, { name: "content" }],
    delayArgResolution: true,
    handler: conditional
  },
  { name: "else", handler: () => ELSE_MARKER },
  { name: "input", handler: (call) => call.context.input ?? "" },
  {
    name: "maxPrompt",
    aliases: ["maxPromptTokens"],
    handler: ({ context: { maxContextTokens: max, maxResponseTokens: response } }) =>
      max === undefined || response === undefined ? "" : String(max - response)
  },
  { name: "maxContext", aliases: ["maxContextTokens"], handler: (call) => tokens(call.context.maxContextTokens) },
  { name: "maxResponse", aliases: ["maxResponseTokens"], handler: (call) => tokens(call.context.maxResponseTokens) },
  { name: "reverse", args: [{ name: "value" }], handler: (call) => Array.from(call.args[0]!).reverse().join("") },
  {
    // The comment's argument is still expanded first, as in ST, so variable writes in a
    // comment take effect.
    name: "//",
    aliases: ["comment"],
    args: [{ name: "comment" }],
    handler: () => ""
  },
  { name: "roll", args: [{ name: "formula" }], volatile: true, handler: roll },
  {
    name: "random",
    volatile: true,
    list: true,
    handler: (call) => {
      const items = choices(call.list)
      return items.length === 0 ? "" : items[Math.floor(call.random() * items.length)]!
    }
  },
  { name: "pick", list: true, volatile: true, handler: pick },
  { name: "banned", args: [{ name: "word" }], handler: () => "" },
  {
    name: "outlet",
    args: [{ name: "key" }],
    handler: ({ args: [key], context: { outlets } }) =>
      key && outlets && Object.hasOwn(outlets, key) ? (outlets[key] ?? "") : ""
  }
]
