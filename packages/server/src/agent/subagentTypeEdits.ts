// Changes to subagent types (spec/SUBAGENTS.md §10), checked one way wherever they come from:
// the settings editor (`ChangeSubagentType`) and the assistant's `change_setting` of
// `subagents.types`. A type may have only tools a workshop offers (less those no subagent gets);
// a change to a registered (built-in or plugin) type keeps only what differs from it; the user's
// own types are complete; the story helper keeps its own settings.
import { foldState } from "@dreamspan/shared/state.ts"
import { SAME, type SubagentTypeEdit, type SubagentTypes } from "@dreamspan/shared/subagents.ts"
import { type ExecutionRegistry, toolForKind } from "../execution.ts"
import { mayUse, NEVER, typesFor, type SubagentType } from "./subagents.ts"

/** The most of the user's own types (`subagents.types` holds at most 32 entries in all). */
const OWN_TYPES = 32

/** The tools a subagent type may have: those workshops offer, less those no subagent gets. */
export const subagentToolCatalog = (registry: ExecutionRegistry["Service"]) => {
  const plan = registry.orchestrationModes.get("workshop")?.plan({ state: foldState([]), kind: "workshop" })
  const seen = new Set<string>()
  return (plan?.tools ?? []).flatMap((id) => {
    const tool = toolForKind(registry, "workshop", id)
    if (!tool || NEVER.has(tool.id) || seen.has(tool.id)) return []
    seen.add(tool.id)
    return [tool]
  })
}

/** What's kept of an edit (null: nothing differs, the type as registered), or why it's refused. */
type Checked = { readonly stored: SubagentTypeEdit | null } | { readonly rejected: string }

/**
 * One type's edit as the settings keep it: a registered type's change with only what differs
 * from it, or a user's own complete type. `catalog`: `subagentToolCatalog`.
 */
export const checkTypeEdit = (
  registered: ReadonlyArray<SubagentType>,
  catalog: ReturnType<typeof subagentToolCatalog>,
  edit: SubagentTypeEdit
): Checked => {
  const id = edit.id
  const unknown = (edit.tools ?? []).filter((tool) => !catalog.some((c) => c.id === tool))
  if (unknown.length) return { rejected: `Not a tool workshops offer: ${unknown.join(", ")}.` }
  const base = registered.find((t) => t.id === id)
  if (base && !base.kinds.includes("workshop"))
    return { rejected: "That subagent has its own settings, in each chat's Tools." }
  if (base) {
    // A change to a built-in or plugin type keeps only what differs from it.
    const baseTools = catalog.filter((tool) => mayUse(base, tool)).map((tool) => tool.id)
    const sameTools =
      edit.tools === undefined ||
      (edit.tools.length === baseTools.length && edit.tools.every((tool) => baseTools.includes(tool)))
    const differs = <K extends "label" | "explanation" | "description" | "instructions" | "defaultAlias">(key: K) =>
      edit[key] !== undefined && edit[key] !== (base[key] ?? "") ? { [key]: edit[key] } : {}
    const change: SubagentTypeEdit = {
      id,
      ...differs("label"),
      ...differs("explanation"),
      ...differs("description"),
      ...differs("instructions"),
      ...differs("defaultAlias"),
      ...(edit.effort !== undefined && edit.effort !== (base.effort ?? null) ? { effort: edit.effort } : {}),
      ...(edit.context !== undefined && edit.context !== (base.context ?? "task") ? { context: edit.context } : {}),
      ...(edit.isolation !== undefined && edit.isolation !== (base.isolation ?? "none")
        ? { isolation: edit.isolation }
        : {}),
      ...(sameTools ? {} : { tools: [...new Set(edit.tools)] }),
      ...(edit.off ? { off: true } : {})
    }
    return { stored: Object.keys(change).length > 1 ? change : null }
  }
  if (!edit.label?.trim() || !edit.instructions?.trim()) return { rejected: "A type needs a name and instructions." }
  return {
    stored: {
      id,
      label: edit.label.trim(),
      ...(edit.explanation?.trim() ? { explanation: edit.explanation.trim() } : {}),
      description: edit.description?.trim() ?? "",
      instructions: edit.instructions,
      tools: [...new Set(edit.tools ?? [])],
      defaultAlias: edit.defaultAlias ?? SAME,
      ...(edit.effort ? { effort: edit.effort } : {}),
      context: edit.context ?? "task",
      ...(edit.isolation && edit.isolation !== "none" ? { isolation: edit.isolation } : {})
    }
  }
}

/**
 * A whole `subagents.types` value, as the assistant writes it with `change_setting`: each entry
 * checked as the editor checks it, ids once each. The value to store, or why it's refused.
 */
export const checkTypeList = (
  registered: ReadonlyArray<SubagentType>,
  catalog: ReturnType<typeof subagentToolCatalog>,
  types: SubagentTypes
): { readonly types: SubagentTypes } | { readonly rejected: string } => {
  const ids = new Set<string>()
  const kept: Array<SubagentTypeEdit> = []
  for (const edit of types) {
    if (ids.has(edit.id)) return { rejected: `The type ${edit.id} is listed twice.` }
    ids.add(edit.id)
    const checked = checkTypeEdit(registered, catalog, edit)
    if ("rejected" in checked) return { rejected: `${edit.id}: ${checked.rejected}` }
    if (checked.stored) kept.push(checked.stored)
  }
  if (kept.length > OWN_TYPES) return { rejected: "That's more subagent types than you may have." }
  return { types: kept }
}

/**
 * Whether a change rewrites a registered (built-in or plugin) type's instructions as they apply:
 * what every chat's subagents of that type are told. The assistant's change of them always asks.
 */
export const changesRegisteredInstructions = (
  registered: ReadonlyArray<SubagentType>,
  before: SubagentTypes,
  after: SubagentTypes
) => {
  const was = new Map(typesFor(registered, before).map((t) => [t.id, t.instructions]))
  return typesFor(registered, after).some(
    (t) => t.source !== "user" && was.has(t.id) && was.get(t.id) !== t.instructions
  )
}
