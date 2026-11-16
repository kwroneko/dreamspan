// The notes and files tools (job wsb3): where the workshop offers them.
//
// The note tools are their own skill, so loading Cards or Library upkeep stays as small as it
// was and the skill index tells the assistant where notes are. The persona flag joins Cards and
// the file tools join Library upkeep. Every tool is deferred: with every tool sent from the start
// the Notes skill adds only its line to load_skill's index (about 25 tokens).
import type { Skill } from "../toolLoading.ts"

/** Hand-written tools the workshop's planner offers beside the registered operations. */
export const parityTools: ReadonlyArray<string> = ["read_note", "edit_library_note"]

/** Added to a built-in skill's tools where it is registered, by skill id. */
export const paritySkillTools: Readonly<Record<string, ReadonlyArray<string>>> = {
  cards: ["set_persona"],
  library: ["list_export_formats", "import_library_file", "list_imports", "read_import"]
}

/** Registered after the built-in skills, exactly as a plugin's would be. */
export const paritySkills: ReadonlyArray<Skill> = [
  {
    id: "notes",
    label: "Notes",
    kinds: ["workshop"],
    description: "Read, write, link and bin shared notes, cards' notes and chats' notes.",
    instructions:
      "A card's or a chat's note can show a shared note's text: edit the shared note to change all of them, or unlink one. A chat's own note is in every branch; switch notes on or off with change_chat (Chat setup). Read a note before editing it.",
    tools: [
      "read_note",
      "list_shared_notes",
      "list_chat_notes",
      "create_shared_note",
      "create_card_note",
      "create_chat_note",
      "edit_library_note",
      "unlink_note",
      "delete_note"
    ]
  }
]
