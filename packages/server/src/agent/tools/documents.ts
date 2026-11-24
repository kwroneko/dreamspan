// Model-shaped edits over the canonical preset and lorebook schemas. A call applies in
// order to one saved document and either saves all of it or saves nothing.
import { Schema } from "effect"
import { PresetDoc, PresetPrompt } from "@dreamspan/shared/docs/preset.ts"
import { LorebookDoc, LorebookEntry, newLorebookEntry } from "@dreamspan/shared/docs/lorebook.ts"
import { mainPrompt } from "@dreamspan/shared/presetOrder.ts"
import { validateDoc } from "@dreamspan/shared/editing.ts"
import type { Doc } from "@dreamspan/shared/library.ts"
import { safeAgentDocument } from "../../db/agentDocuments.ts"
import { workshopLimits as limits } from "../../workshopLimits.ts"

const name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(limits.nameChars))
const text = Schema.String.check(Schema.isMaxLength(limits.textChars))
const partial = (fields: Schema.Struct.Fields, omit: readonly string[] = []) =>
  Schema.Struct(
    Object.fromEntries(
      Object.entries(fields)
        .filter(([key]) => !omit.includes(key))
        .map(([key, schema]) => [key, Schema.optionalKey(schema)])
    )
  )
const changes = <S extends Schema.Top>(schema: S) =>
  Schema.Array(schema).check(Schema.isMinLength(1), Schema.isMaxLength(limits.listItems))
export const presetEditArguments = Schema.Struct({
  preset: name,
  changes: changes(
    Schema.Union([
      Schema.Struct({ prompt: name, text }),
      Schema.Struct({ prompt: name, find: text.check(Schema.isMinLength(1)), replace: text }),
      Schema.Struct({ prompt: name, enabled: Schema.Boolean }),
      Schema.Struct({ prompt: name, before: Schema.NullOr(name) }),
      Schema.Struct({ prompt: name, set: partial(PresetPrompt.fields, ["identifier"]) }),
      Schema.Struct({
        add: Schema.Struct({ identifier: name, ...partial(PresetPrompt.fields, ["identifier"]).fields }),
        before: Schema.optionalKey(Schema.NullOr(name)),
        enabled: Schema.optionalKey(Schema.Boolean)
      }),
      Schema.Struct({ remove: name }),
      Schema.Struct({
        settings: partial(PresetDoc.fields, [
          "schema_version",
          "prompts",
          "order",
          "regex_approved",
          "html_scripts_approved",
          "html_network_approved"
        ])
      })
    ])
  )
})
export const lorebookEditArguments = Schema.Struct({
  lorebook: name,
  changes: changes(
    Schema.Union([
      Schema.Struct({ entry: Schema.Int, set: partial(LorebookEntry.fields, ["uid"]) }),
      Schema.Struct({ entry: Schema.Int, text }),
      Schema.Struct({ entry: Schema.Int, find: text.check(Schema.isMinLength(1)), replace: text }),
      Schema.Struct({ entry: Schema.Int, enabled: Schema.Boolean }),
      Schema.Struct({ entry: Schema.Int, before: Schema.NullOr(Schema.Int) }),
      Schema.Struct({ add: Schema.Struct({ uid: Schema.Int, ...partial(LorebookEntry.fields, ["uid"]).fields }) }),
      Schema.Struct({ remove: Schema.Int }),
      Schema.Struct({ settings: partial(LorebookDoc.fields, ["schema_version", "entries"]) })
    ])
  )
})
const replace = (current: string, change: Record<string, unknown>) => {
  if (typeof change.text === "string") return change.text
  const find = String(change.find)
  const first = current.indexOf(find)
  if (!find || first < 0 || current.indexOf(find, first + 1) !== -1)
    throw new Error("Find must occur exactly once. Read the saved document again.")
  return current.replace(find, () => String(change.replace))
}
const move = <A>(items: readonly A[], index: number, before: unknown, identity: (item: A) => unknown) => {
  const next = [...items]
  const [item] = next.splice(index, 1)
  if (before === identity(item!)) throw new Error("An item cannot be placed before itself.")
  const at = before === null ? next.length : next.findIndex((e) => identity(e) === before)
  if (at < 0) throw new Error("The requested position does not exist. Read the saved document again.")
  next.splice(at, 0, item!)
  return next
}

export const editDocument = (
  kind: "preset" | "lorebook",
  saved: Doc,
  changes: readonly Record<string, unknown>[]
): Doc => {
  let doc = structuredClone(saved)
  for (const change of changes) {
    if ("settings" in change) {
      doc = { ...doc, ...(change.settings as object) }
      continue
    }
    if (kind === "preset") {
      let { prompts, order } = doc as unknown as PresetDoc
      if ("add" in change) {
        const added = {
          ...mainPrompt,
          name: "New prompt",
          system_prompt: false,
          forbid_overrides: false,
          ...(change.add as object)
        }
        if (prompts.some((p) => p.identifier === added.identifier))
          throw new Error("That prompt identifier already exists.")
        prompts = [...prompts, added]
        order = [...order, { identifier: added.identifier, enabled: change.enabled !== false }]
        if (change.before !== undefined) order = move(order, order.length - 1, change.before, (e) => e.identifier)
      } else {
        const id = change.prompt ?? change.remove
        const index = prompts.findIndex((p) => p.identifier === id)
        if (index < 0) throw new Error("That prompt does not exist. Use its identifier from read_preset.")
        if ("remove" in change) {
          if (id === "main") throw new Error("Main is permanent. You can switch it off or move it.")
          prompts = prompts.filter((p) => p.identifier !== id)
          order = order.filter((p) => p.identifier !== id)
        } else if ("before" in change || "enabled" in change) {
          let at = order.findIndex((p) => p.identifier === id)
          if (at < 0) {
            order = [...order, { identifier: String(id), enabled: false }]
            at = order.length - 1
          }
          order =
            "before" in change
              ? move(order, at, change.before, (e) => e.identifier)
              : order.map((p) => (p.identifier === id ? { ...p, enabled: change.enabled === true } : p))
        } else
          prompts = prompts.map((p, i) =>
            i === index
              ? { ...p, ...("set" in change ? (change.set as object) : { content: replace(p.content, change) }) }
              : p
          )
      }
      doc = { ...doc, prompts, order }
    } else {
      let { entries } = doc as unknown as LorebookDoc
      if ("add" in change) {
        const fields = change.add as { uid: number }
        const added = { ...newLorebookEntry(fields.uid), ...fields }
        if (entries.some((e) => e.uid === added.uid)) throw new Error("That entry id already exists.")
        entries = [...entries, added]
      } else {
        const id = change.entry ?? change.remove
        const at = entries.findIndex((e) => e.uid === id)
        if (at < 0) throw new Error("That entry does not exist. Use its uid from read_lorebook.")
        if ("remove" in change) entries = entries.filter((e) => e.uid !== id)
        else if ("before" in change) entries = move(entries, at, change.before, (e) => e.uid)
        else
          entries = entries.map((e, i) =>
            i === at
              ? {
                  ...e,
                  ...("set" in change
                    ? (change.set as object)
                    : "enabled" in change
                      ? { enabled: change.enabled === true }
                      : { content: replace(e.content, change) })
                }
              : e
          )
      }
      doc = { ...doc, entries }
    }
  }
  const valid = validateDoc(kind, doc)
  if (!valid.ok) throw new Error(valid.problems.join("; "))
  if (
    kind === "lorebook" &&
    new Set((valid.doc as unknown as LorebookDoc).entries.map((e) => e.uid)).size !==
      (valid.doc as unknown as LorebookDoc).entries.length
  )
    throw new Error("Entry ids must be unique.")
  return safeAgentDocument(kind, saved, valid.doc)
}
