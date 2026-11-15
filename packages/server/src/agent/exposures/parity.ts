// The notes and files tools (job wsb3): where the workshop offers them.
//
// Each joins the skill of the area it works in, so the two loading tools' definitions (the skill
// index, and the names no skill covers) stay byte for byte what they were: the tools are found by
// loading that skill or by `tool_search`, and the part of a request a provider caches is unchanged.

/** Hand-written tools the workshop's planner offers beside the registered operations. */
export const parityTools: ReadonlyArray<string> = ["read_note", "edit_library_note"]

/** Added to a built-in skill's tools where it is registered, by skill id. */
export const paritySkillTools: Readonly<Record<string, ReadonlyArray<string>>> = {
  cards: ["read_note", "list_shared_notes", "create_card_note", "edit_library_note", "unlink_note", "set_persona"],
  library: [
    "read_note",
    "list_shared_notes",
    "create_shared_note",
    "edit_library_note",
    "delete_note",
    "list_export_formats",
    "import_library_file",
    "list_imports",
    "read_import"
  ],
  "chat-setup": ["list_chat_notes", "create_chat_note"]
}
