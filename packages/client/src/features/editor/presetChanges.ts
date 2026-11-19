// What a preset's unsaved drafts change, in words, for the Prompt preset tab's bar: the order,
// switches, prompts added or deleted, whose text or options changed, and anything else.
import type { PresetLorebook, PresetPrompt, PromptOrderEntry } from "@dreamspan/shared/docs/preset.ts"
import { parseField } from "@dreamspan/shared/editing.ts"
import { presetOrder } from "@dreamspan/shared/presetOrder.ts"
import { promptLabel } from "./promptLabel.ts"

interface PresetLike {
  readonly prompts?: ReadonlyArray<PresetPrompt>
  readonly order?: ReadonlyArray<PromptOrderEntry>
  readonly lorebooks?: ReadonlyArray<PresetLorebook>
}

const orderOf = (doc: PresetLike) => presetOrder(doc.prompts ?? [], doc.order ?? [])

const named = (what: string, names: ReadonlyArray<string>) =>
  names.length === 0
    ? []
    : names.length <= 2
      ? [`${what} of ${names.join(" and ")}`]
      : [`${what} of ${names.length} prompts`]

const count = (n: number, one: string, many: string) => (n === 0 ? [] : [`${n} ${n === 1 ? one : many}`])

/** Phrases for the bar, most structural first: "new order", "2 switches", "text of Main Prompt". */
export function describePresetChanges(
  head: unknown,
  current: unknown,
  dirtyFields: ReadonlyArray<string>
): ReadonlyArray<string> {
  const before = orderOf(head as PresetLike)
  const after = orderOf(current as PresetLike)
  const was = new Map(before.map((e) => [e.identifier, e]))
  const now = new Map(after.map((e) => [e.identifier, e]))
  const added = after.filter((e) => !was.has(e.identifier)).map((e) => e.identifier)
  const removed = before.filter((e) => !now.has(e.identifier)).map((e) => e.identifier)
  const kept = (list: ReadonlyArray<PromptOrderEntry>, other: Map<string, PromptOrderEntry>) =>
    list.filter((e) => other.has(e.identifier)).map((e) => e.identifier)
  const moved = kept(before, now).join("\n") !== kept(after, was).join("\n")
  const switches = after.filter((e) => {
    const old = was.get(e.identifier)
    return old !== undefined && old.enabled !== e.enabled
  }).length
  const prompts = new Map(((current as PresetLike).prompts ?? []).map((p) => [p.identifier, p]))
  const name = (identifier: string) => {
    const p = prompts.get(identifier)
    return p ? (p.marker ? p.name : promptLabel(p.name, p.content).text) : identifier
  }
  const texts = new Set<string>()
  const options = new Set<string>()
  const renamed = new Set<string>()
  let other = 0
  const fresh = new Set([...added, ...removed])
  for (const key of dirtyFields) {
    const field = parseField(key)
    if (!field) continue
    const [list, identity, part] = field.path
    if (list === "order") continue
    if (list === "prompts" && typeof identity === "string" && identity.startsWith("identifier=")) {
      const identifier = identity.slice("identifier=".length)
      if (part === undefined || fresh.has(identifier)) continue
      if (part === "content") texts.add(identifier)
      else if (part === "name") renamed.add(identifier)
      else options.add(identifier)
    } else other += 1
  }
  const booksBefore = new Set(((head as PresetLike).lorebooks ?? []).map((b) => b.id))
  const booksNow = new Set(((current as PresetLike).lorebooks ?? []).map((b) => b.id))
  const attached = [...booksNow].filter((id) => !booksBefore.has(id)).length
  const detached = [...booksBefore].filter((id) => !booksNow.has(id)).length
  return [
    ...(moved ? ["new order"] : []),
    ...count(switches, "switch", "switches"),
    ...count(added.length, "prompt added", "prompts added"),
    ...count(removed.length, "prompt deleted", "prompts deleted"),
    ...count(attached, "lorebook attached", "lorebooks attached"),
    ...count(detached, "lorebook taken off", "lorebooks taken off"),
    ...named("text", [...texts].map(name)),
    ...(renamed.size === 0
      ? []
      : renamed.size <= 2
        ? [`renamed ${[...renamed].map(name).join(" and ")}`]
        : [`${renamed.size} prompts renamed`]),
    ...named("options", [...options].map(name)),
    ...count(other, "other setting", "other settings")
  ]
}
