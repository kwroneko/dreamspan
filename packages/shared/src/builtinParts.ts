import { macroParts } from "./macros/catalog.ts"
// Only complete, typed adapters may replace built-ins through stable plugin handles.
const parts: Record<string, { side: "client" | "server" | "worker"; label: string }> = {
  "noticeChannels:notifications.completion-sound": { side: "client", label: "Completion sound" },
  "rolloutTools:set_presence": { side: "server", label: "Who's present (set_presence)" },
  "macros:reverse": { side: "worker", label: "Reverse text macro (reverse)" }
}
for (const part of macroParts)
  for (const id of [part.id, ...part.aliases])
    if (!parts[`macros:${id}`])
      parts[`macros:${id}`] = {
        side: "worker",
        label: `${part.name} macro (${id})`
      }
for (const [id, label] of [
  ["research", "Look things up (research)"],
  ["code", "Work on files (code)"],
  ["general", "Work on part of the task (general)"]
])
  parts[`subagentTypes:${id}`] = { side: "server", label: label! }
for (const id of ["search_chat", "read_messages", "expand_summary", "search_summaries", "list_notes", "switch_note"])
  parts[`rolloutTools:${id}`] = { side: "server", label: id }
for (const [registry, entries] of Object.entries({
  timelineTransforms: [
    ["timeline.merges", "Merged chat rows"],
    ["timeline.history-budget", "History budget divider"],
    ["timeline.lcm", "Summary rows and divider"],
    ["timeline.threads", "Parallel thread dividers"]
  ],
  displayTransforms: [
    ["display.macros", "Display macros"],
    ["display.regex", "Display regex"]
  ],
  displayScriptLists: [
    ["display-regex.global", "Global display scripts"],
    ["display-regex.preset", "Preset display scripts"],
    ["display-regex.character", "Character display scripts"]
  ]
}))
  for (const [id, label] of entries) parts[`${registry}:${id}`] = { side: "client", label: label! }
export const builtinReplacement = (key: string) => (Object.hasOwn(parts, key) ? parts[key] : undefined)

/** A repository-safe suggestion, including the comment macro's symbolic name. */
export const builtinCopyStem = (id: string) =>
  (id === "//"
    ? "comment"
    : id
        .replace(/^notifications\./, "")
        .toLowerCase()
        .replaceAll("_", "-")
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/^-+/, "part-")
  ).slice(0, 42)
