// Notes that replace prompts (DESIGN §4.2; spec/NOTE-OVERRIDES.md §3). A note with `replaces`
// names a preset prompt (by its identifier, in whichever preset the chat uses) or a card field
// (by the character's place in the chat). The registered `replacements` stage, after
// `note-gate`, decides which notes replace what on this turn; `compose` then sends each one's
// text in its target's place (`replacedText`), or leaves the target out when the note goes at
// its own position. Anything that wants a prompt replaced in a chat, an agent tool among them
// (Phase 4), writes such a note: nothing else needs to know.
import { readReplaceTarget, type ReplaceTarget, targetCard } from "@dreamspan/shared/docs/note.ts"
import { presetOrder, withMain } from "@dreamspan/shared/presetOrder.ts"
import { type FoldableEvent, swappedCard } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { type AssemblerStage, type Assembly, need } from "./pipeline.ts"
import { noteCard, type NoteInput, type NoteReplacement, type ResolvedTarget } from "./types.ts"

/** One key per target: `preset:<identifier>`, `card:<entity>:<field>`. */
const replaceKey = (target: ResolvedTarget) =>
  target.kind === "preset_prompt" ? `preset:${target.identifier}` : `card:${target.card}:${target.field}`

/** A card field's key, for the composition's lookups. */
export const cardFieldKey = (card: string, field: string) => `card:${card}:${field}`

/**
 * The note's target on this path: a card field's place followed through the branch's swaps to
 * the card that fills it now (a card forked for this chat, another version). Null when a chat's
 * note names a card field but no card.
 */
const resolveTarget = (
  target: ReplaceTarget,
  owner: string | null,
  events: Iterable<FoldableEvent>
): ResolvedTarget | null => {
  if (target.kind === "preset_prompt") return { kind: "preset_prompt", identifier: target.identifier }
  const named = targetCard(target, owner)
  if (named === null) return null
  return { kind: "card_field", card: swappedCard(events, named) ?? named, field: target.field }
}

/** Notes sort as `placedNotes` sorts them: the chat's first, then cards', each by id. */
const order = (a: NoteInput, b: NoteInput) => {
  const rank = (note: NoteInput) => (noteCard(note.doc) === null ? 0 : 1)
  return rank(a) - rank(b) || (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0)
}

/**
 * Decides which on notes replace what this turn. A note whose condition doesn't hold leaves its
 * target as it is (`not_due`); a card's note can't replace a preset prompt that forbids
 * overrides; one note per target, the first in note order (a second is `conflict`, with an
 * issue). Notes that go in their target's place leave the notes to be placed; ones with their
 * own position stay, and their target is left out.
 */
export const replacementsStage: AssemblerStage = {
  id: "replacements",
  run: (assembly) =>
    Effect.sync(() => {
      const due = assembly.notes ?? []
      const skipped = assembly.skippedNotes ?? []
      const replacing = [...due, ...skipped].filter((note) => readReplaceTarget(note.doc.replaces) !== null)
      if (replacing.length === 0) return assembly
      const events = need(assembly, "events").map((e) => e.event)
      const cast = need(assembly, "cast")
      const members = new Set([...cast.characters, ...cast.personas].map((card) => card.entity))
      const preset = withMain(need(assembly, "preset").doc)
      const prompts = new Map(preset.prompts.map((p) => [p.identifier, p]))
      const enabled = new Map(presetOrder(preset.prompts, preset.order).map((e) => [e.identifier, e.enabled]))
      const map = new Map<string, { readonly note: NoteInput; readonly record: NoteReplacement }>()
      const records: Array<NoteReplacement> = []
      const taken = new Set<NoteInput>()
      for (const note of replacing.toSorted(order)) {
        const target = resolveTarget(readReplaceTarget(note.doc.replaces)!, noteCard(note.doc), events)
        if (target === null) continue
        const ownPosition = note.doc.own_position === true
        const record: NoteReplacement = {
          entity: note.entity,
          revision: note.revision,
          target,
          ownPosition,
          status: ownPosition ? "own_position" : "replaced"
        }
        records.push(record)
        const key = replaceKey(target)
        const prompt = target.kind === "preset_prompt" ? prompts.get(target.identifier) : undefined
        if (target.kind === "preset_prompt" ? prompt === undefined : !members.has(target.card))
          record.status = ownPosition ? "own_position" : "missing"
        else if (target.kind === "preset_prompt" && noteCard(note.doc) !== null && prompt?.forbid_overrides)
          record.status = "forbidden"
        else if (map.has(key)) {
          record.status = "conflict"
          assembly.issues.push({
            kind: "note_replacement",
            message: `Two notes replace the same prompt; only the first is used.`
          })
        } else if (skipped.includes(note)) record.status = "not_due"
        else if (target.kind === "preset_prompt" && enabled.get(target.identifier) === false && !ownPosition)
          record.status = "disabled"
        if (record.status === "forbidden" || record.status === "conflict") {
          taken.add(note)
          continue
        }
        if (record.status === "missing" && !ownPosition) {
          taken.add(note)
          continue
        }
        if (record.status !== "missing") map.set(key, { note, record })
        // One that goes in its target's place is never placed as a note of its own.
        if (!ownPosition) taken.add(note)
      }
      assembly.replacements = map
      assembly.noteReplacements = records
      assembly.notes = due.filter((note) => !taken.has(note))
      assembly.skippedNotes = skipped.filter((note) => !taken.has(note))
      return assembly
    })
}

/** The replacement on this turn for a target, when one applies to what's sent (not `missing` and so on). */
export const replacementFor = (assembly: Assembly, key: string) => {
  const found = assembly.replacements?.get(key)
  if (!found) return undefined
  return found.record.status === "replaced" ||
    found.record.status === "own_position" ||
    found.record.status === "not_due" ||
    found.record.status === "disabled"
    ? found
    : undefined
}
