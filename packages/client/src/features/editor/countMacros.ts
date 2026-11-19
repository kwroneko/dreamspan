// Macros in counted text (coordinator, 2026-11-02, following ST): ST's character panel counts
// an existing card's fields after `substituteParams`, so `{{char}}` counts as the name it becomes
// (SillyTavern public/scripts/RossAscends-mods.js `RA_CountCharTokens`). Here `{{user}}` is who
// the user plays in the open chat (the chat's cast), else "User" as in ST; `{{char}}` is the
// card's own name for chats; `{{description}}` and the like read the card's own fields, as the
// display's expansion does (chat/macros.ts).
import { cardNames } from "@dreamspan/shared/cardNames.ts"
import type { CardFields } from "@dreamspan/shared/macros/context.ts"
import { useMemo } from "react"
import { useCast } from "../chat/cast.ts"
import { type DisplayNames, expandForDisplay } from "../chat/macros.ts"
import { type EditorStore, useWorkingDoc } from "./store.ts"

const text = (value: unknown) => (typeof value === "string" ? value : "")

/** What the counts' explanations say about macros. */
export const MACROS_COUNTED =
  "Counted with macros as they become: {{char}} as this card's name, {{user}} as who you play in this chat (else User)."

/** Expands the macros of the card's texts as ST does before it counts them. */
export function useCountMacros(store: EditorStore): (value: string) => string {
  const doc = useWorkingDoc(store)
  const user = useCast().user
  const char = cardNames(doc).modelName
  const card: CardFields = useMemo(
    () => ({
      description: text(doc.description),
      personality: text(doc.personality),
      scenario: text(doc.scenario),
      mesExamples: text(doc.mes_example),
      systemPrompt: text(doc.system_prompt),
      postHistoryInstructions: text(doc.post_history_instructions),
      firstMessage: text(doc.first_mes),
      creatorNotes: text(doc.creator_notes),
      version: text(doc.character_version)
    }),
    [doc]
  )
  return useMemo(() => (value: string) => countedText(value, { user, char }, card), [user, char, card])
}

/** A text as it's counted: its macros expanded with these names and the card's fields. */
export const countedText = (value: string, names: DisplayNames, card: CardFields) =>
  expandForDisplay(value, "template", names, card).text
