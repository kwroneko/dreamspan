import { chatCommands } from "./commands.tsx"

// Both entries intentionally open the same history workspace, as before.
export const registerHistoryCommands = () => [
  chatCommands.register({
    id: "history.search-replace",
    shortcut: { key: "h", mod: true },
    // In the menu too: it's also an action, not only a key.
    menu: true,
    label: "Search and replace",
    description: "Finds text in this branch's messages, swipes and summaries, and replaces it.",
    order: 10,
    icon: "search",
    panel: "history",
    run: ({ onHistory }) => onHistory()
  }),
  chatCommands.register({
    id: "history.edits",
    label: "History edits",
    description: "What search and replace or a card's rename changed in this branch, to see or undo.",
    order: 20,
    icon: "edit",
    panel: "history",
    run: ({ onHistory }) => onHistory()
  })
]
