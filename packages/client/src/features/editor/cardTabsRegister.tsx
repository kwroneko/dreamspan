// The built-in card editor tabs (`cardTabs.ts`), each loaded with the editor that shows it.
import { lazy, Suspense } from "react"
import type { FieldPath } from "@dreamspan/shared/editing.ts"
import { Loading } from "../../ui/Spinner.tsx"
import {
  CARD_TAB_DEFINITION,
  CARD_TAB_EXTRA,
  CARD_TAB_GREETINGS,
  CARD_TAB_LOREBOOK,
  CARD_TAB_METADATA,
  CARD_TAB_NOTES,
  type CardTabProps,
  cardEditorTabs
} from "./cardTabs.ts"

/** The fields at the top of a card's document each tab holds, for search's Go to. */
const top =
  (...fields: ReadonlyArray<string>) =>
  (path: FieldPath) =>
    fields.includes(String(path[0]))

/** A card's skills (`extensions.dreamspan`), which the Extra tab's Skills section edits. */
const skills = (path: FieldPath) => path[0] === "extensions" && path[1] === "dreamspan"

type Panel = "definition" | "greetings" | "metadata" | "lorebook" | "notes" | "extra"

const panel = (name: Panel) => {
  const Lazy = lazy(() => import("./CardEditor.tsx").then((module) => ({ default: module.CARD_TAB_PANELS[name] })))
  return function CardTabPanel(props: CardTabProps) {
    return (
      <Suspense fallback={<Loading label="Opening the tab…" />}>
        <Lazy {...props} />
      </Suspense>
    )
  }
}

export const registerCardTabs = () => [
  cardEditorTabs.register({
    id: CARD_TAB_DEFINITION,
    order: 10,
    label: "Definition",
    description:
      "What goes into the prompt: description, personality, scenario, example messages and the card's own prompts.",
    component: panel("definition"),
    holds: top("description", "personality", "scenario", "mes_example", "system_prompt", "post_history_instructions")
  }),
  cardEditorTabs.register({
    id: CARD_TAB_GREETINGS,
    order: 20,
    label: "Greetings",
    description: "The first message, alternate greetings, and greetings for group chats.",
    component: panel("greetings"),
    holds: top("first_mes", "alternate_greetings", "group_only_greetings")
  }),
  cardEditorTabs.register({
    id: CARD_TAB_METADATA,
    order: 30,
    label: "Metadata",
    description:
      "What isn't prompt text: creator's notes, tags, creator, talkativeness in group chats, where the card came from.",
    component: panel("metadata"),
    holds: (path) => top("creator_notes", "tags", "creator", "extensions")(path) && !skills(path)
  }),
  cardEditorTabs.register({
    id: CARD_TAB_LOREBOOK,
    order: 40,
    label: "Lorebook",
    description: "The card's own lorebook, which travels with it.",
    component: panel("lorebook"),
    holds: top("character_book")
  }),
  cardEditorTabs.register({
    id: CARD_TAB_NOTES,
    order: 50,
    label: "Notes",
    description: "The card's notes, its Character's Note among them: outfits, situations, private notes.",
    component: panel("notes")
  }),
  cardEditorTabs.register({
    id: CARD_TAB_EXTRA,
    order: 60,
    label: "Extra",
    description: "Regex scripts, skills and anything else the card carries.",
    component: panel("extra"),
    holds: (path) => top("regex")(path) || skills(path)
  })
]
