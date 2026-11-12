// The built-in skills (spec/TOOL-LOADING.md §5): the workshop's tools in groups the assistant loads
// as it needs them, each with a short instruction. Registered through `ExecutionRegistry.skills`
// exactly as a plugin's would be; a plugin can replace, disable or add to them.
import type { Skill } from "./toolLoading.ts"

const workshop = ["workshop"]

export const builtinSkills: ReadonlyArray<Skill> = [
  {
    id: "cards",
    label: "Cards",
    kinds: workshop,
    // Offered when the workshop's card names it; the seeded Assistant card names them all.
    always: false,
    description: "Read, create, edit and copy character cards, and mark favourites.",
    instructions:
      "Find a card with list_library first and use its id when names repeat. Read a card before editing it, and change only the fields asked for. To keep the original, copy it with clone_card and edit the copy.",
    tools: ["read_card", "create_card", "edit_card", "clone_card", "set_card_favourite"]
  },
  {
    id: "presets-lorebooks",
    label: "Presets and lorebooks",
    kinds: workshop,
    // Offered when the workshop's card names it; the seeded Assistant card names them all.
    always: false,
    description: "Read and create presets and lorebooks.",
    instructions:
      "Read a preset or lorebook before suggesting changes to it. New presets and lorebooks start empty unless you say what goes in them.",
    tools: ["read_preset", "read_lorebook", "create_preset", "create_lorebook"]
  },
  {
    id: "library",
    label: "Library upkeep",
    kinds: workshop,
    // Offered when the workshop's card names it; the seeded Assistant card names them all.
    always: false,
    description: "Copy, rename, archive or restore library entries, and go back to an earlier revision.",
    instructions:
      "List an entry's revisions before restoring one, and say which revision you restored. Archiving hides an entry without deleting it.",
    tools: ["fork_variant", "rename_ref", "set_ref_archived", "restore_revision", "list_revisions"]
  },
  {
    id: "chat-setup",
    label: "Chat setup",
    kinds: workshop,
    // Offered when the workshop's card names it; the seeded Assistant card names them all.
    always: false,
    description:
      "Start story chats, change a chat's cast, model or preset, rename or pin chats, and write a reply in another chat.",
    instructions:
      "Look up chats with list_chats and read one's cast with get_cast before changing it. Starting a chat never writes a reply; generate_reply does, and asks first.",
    tools: ["start_chat", "list_chats", "get_cast", "change_chat", "rename_chat", "set_chat_pin", "generate_reply"]
  },
  {
    id: "stories",
    label: "Reading stories",
    kinds: workshop,
    // Offered when the workshop's card names it; the seeded Assistant card names them all.
    always: false,
    description: "Search a chat's history, and rename a word or name throughout it.",
    instructions:
      "Search before renaming, so you know how many places change. A rename changes the chat's history and can be undone.",
    tools: ["history_search", "history_rename", "list_chats"]
  },
  {
    id: "settings",
    label: "Settings",
    kinds: workshop,
    // Offered when the workshop's card names it; the seeded Assistant card names them all.
    always: false,
    description: "Read and change app settings and generation defaults.",
    instructions: "Read the current settings before changing one, and change only what was asked.",
    tools: ["read_settings", "change_setting", "change_generation_defaults"]
  }
]
