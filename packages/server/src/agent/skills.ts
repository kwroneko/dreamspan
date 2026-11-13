// The built-in skills (spec/TOOL-LOADING.md §5): the workshop's tools in groups the assistant loads
// as it needs them, each with a short instruction. Registered through `ExecutionRegistry.skills`
// exactly as a plugin's would be; a plugin can replace, disable or add to them. They're offered in
// every workshop whatever card it uses (**[D]**): a card's own skills come on top.
import type { Skill } from "./toolLoading.ts"

const workshop = ["workshop"]

export const builtinSkills: ReadonlyArray<Skill> = [
  {
    id: "cards",
    label: "Cards",
    kinds: workshop,
    description: "Read, create, edit and copy character cards, and mark favourites.",
    instructions:
      "Find a card with list_library first and use its id when names repeat. Read a card before editing it, and change only the fields asked for. To keep the original, copy it with clone_card and edit the copy.",
    tools: ["read_card", "create_card", "edit_card", "clone_card", "set_card_favourite"]
  },
  {
    id: "presets-lorebooks",
    label: "Presets and lorebooks",
    kinds: workshop,
    description: "Read, create and edit presets and lorebooks.",
    instructions:
      "Read a preset or lorebook before suggesting changes to it, and change only what was asked. New presets and lorebooks start empty unless you say what goes in them.",
    tools: ["read_preset", "read_lorebook", "create_preset", "create_lorebook", "edit_preset", "edit_lorebook"]
  },
  {
    id: "this-workshop",
    label: "This conversation",
    kinds: workshop,
    description: "Look back through this conversation: earlier messages, their summaries and the steps of earlier replies.",
    instructions:
      "Search or read this conversation's earlier messages when they've left your view. To check what an earlier reply of yours looked up, read its steps with read_run instead of looking it up again.",
    tools: ["search_chat", "read_messages", "expand_summary", "search_summaries", "read_run"]
  },
  {
    id: "library",
    label: "Library upkeep",
    kinds: workshop,
    description: "Copy, rename, archive or restore library entries, and go back to an earlier revision.",
    instructions:
      "List an entry's revisions before restoring one, and say which revision you restored. Archiving hides an entry without deleting it.",
    tools: ["fork_variant", "rename_ref", "set_ref_archived", "restore_revision", "list_revisions"]
  },
  {
    id: "chat-setup",
    label: "Chat setup",
    kinds: workshop,
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
    description: "Read and search a chat's history, rename a word or name throughout it, and rewrite its text.",
    instructions:
      "Read or search before changing anything, so you know how many places change. A rename or rewrite changes the chat's history and can be undone.",
    tools: [
      "history_search",
      "history_rename",
      "list_chats",
      "read_chat",
      "search_chats",
      "rewrite_chat",
      "rewrite_messages",
      "rewrite_instructions"
    ]
  },
  {
    id: "settings",
    label: "Settings",
    kinds: workshop,
    description: "Read and change app settings and generation defaults.",
    instructions: "Read the current settings before changing one, and change only what was asked.",
    tools: ["read_settings", "change_setting", "change_generation_defaults"]
  }
]
