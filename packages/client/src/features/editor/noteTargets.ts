// What a note replaces (DESIGN §4.2; spec/NOTE-OVERRIDES.md): the target an editor field is, a
// target in words, and the choices a note's Replaces control offers. The note-overrides feature
// supplies the open chat's names (`NoteTargetsContext`); without a chat, labels fall back to
// the field's and the prompt's own.
import {
  type ReplaceableCardField,
  REPLACEABLE_CARD_FIELDS,
  type ReplaceTarget,
  readReplaceTarget,
  targetCard
} from "@rp/shared/docs/note.ts"
import type { FieldPath } from "@rp/shared/editing.ts"
import { endOfRequestText } from "@rp/shared/endOfRequest.ts"
import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import { presetOrder } from "@rp/shared/presetOrder.ts"
import { createContext, useContext } from "react"
import { promptLabel } from "./promptLabel.ts"

export const CARD_FIELD_LABELS: Readonly<Record<ReplaceableCardField, string>> = {
  description: "Description",
  personality: "Personality",
  scenario: "Scenario",
  mes_example: "Example messages",
  system_prompt: "System prompt",
  post_history_instructions: "Post-history instructions"
}

/** A target with its card filled in (a card field's place), so two notes' targets compare. */
export type FieldTarget =
  | { readonly kind: "preset_prompt"; readonly identifier: string }
  | { readonly kind: "card_field"; readonly card: string; readonly field: ReplaceableCardField }

export const targetKey = (target: FieldTarget) =>
  target.kind === "preset_prompt" ? `preset:${target.identifier}` : `card:${target.card}:${target.field}`

/** A note's stored target, its own card filled in for a card's note; null without one. */
export const noteTarget = (doc: Readonly<Record<string, unknown>>): FieldTarget | null => {
  const target = readReplaceTarget(doc["replaces"])
  if (target === null) return null
  if (target.kind === "preset_prompt") return target
  const owner = (doc["owner"] as { card?: string } | undefined)?.card ?? null
  const card = targetCard(target, owner)
  return card === null ? null : { kind: "card_field", card, field: target.field }
}

/** What's stored for a target: a card's note leaves its own card out. */
export const storedTarget = (target: FieldTarget, ownerCard: string | null): ReplaceTarget =>
  target.kind === "preset_prompt"
    ? target
    : target.card === ownerCard
      ? { kind: "card_field", field: target.field }
      : { kind: "card_field", field: target.field, card: target.card as never }

/**
 * The target an editor's text field is: a card's prompt field, or a preset prompt's text. Null
 * for any other field.
 */
export const fieldTarget = (
  kind: string | undefined,
  entity: string | undefined,
  path: FieldPath
): FieldTarget | null => {
  if (
    kind === "card" &&
    entity &&
    path.length === 1 &&
    (REPLACEABLE_CARD_FIELDS as ReadonlyArray<unknown>).includes(path[0])
  )
    return { kind: "card_field", card: entity, field: path[0] as ReplaceableCardField }
  if (kind === "preset" && path.length === 3 && path[0] === "prompts" && path[2] === "content") {
    const step = String(path[1])
    return step.startsWith("identifier=")
      ? { kind: "preset_prompt", identifier: step.slice("identifier=".length) }
      : null
  }
  return null
}

/** The open chat's names for targets: its cast's cards and its preset's prompts. */
export interface NoteTargetNames {
  readonly card: (entity: string) => string | undefined
  readonly prompt: (identifier: string) => string | undefined
}

export const NoteTargetsContext = createContext<NoteTargetNames | null>(null)
export const useNoteTargetNames = () => useContext(NoteTargetsContext)

/** The built-in prompts' names, for a target outside a chat. */
const BUILTIN_PROMPTS: Readonly<Record<string, string>> = {
  main: "Main Prompt",
  jailbreak: "Post-History Instructions",
  nsfw: "Auxiliary Prompt",
  enhanceDefinitions: "Enhance Definitions"
}

/** A target in words: "Mira's Description", "the Main Prompt". */
export const targetLabel = (
  target: FieldTarget,
  names: NoteTargetNames | null,
  cardName?: (entity: string) => string | undefined
) => {
  if (target.kind === "preset_prompt")
    return names?.prompt(target.identifier) ?? BUILTIN_PROMPTS[target.identifier] ?? target.identifier
  const name = names?.card(target.card) ?? cardName?.(target.card)
  return `${name ?? "A card"}'s ${CARD_FIELD_LABELS[target.field]}`
}

/**
 * The preset's prompts a note can replace: those with text of their own (not a marker of where
 * the chat or the cards go, not the end-of-request texts), in the preset's order.
 */
export const replaceablePrompts = (prompts: ReadonlyArray<PresetPrompt>, order: ReadonlyArray<PromptOrderEntry>) => {
  const byId = new Map(prompts.map((p) => [p.identifier, p]))
  const ordered = presetOrder(prompts, order)
  const history = ordered.findIndex((entry) => entry.identifier === "chatHistory")
  return ordered.flatMap((entry, index) => {
    const prompt = byId.get(entry.identifier)
    if (!prompt || prompt.marker || endOfRequestText(prompt.identifier)) return []
    return [
      {
        identifier: prompt.identifier,
        name: promptLabel(prompt.name, prompt.content).text,
        content: prompt.content,
        enabled: entry.enabled,
        forbidden: prompt.forbid_overrides === true,
        role: prompt.role,
        /** At a depth in the chat, or in its place in the list. */
        depth: prompt.injection_position === "absolute" ? prompt.injection_depth : null,
        /** Sent above the chat history, in the cached part of the context. */
        aboveHistory: prompt.injection_position !== "absolute" && (history < 0 || index < history)
      }
    ]
  })
}
