import { macroParts } from "@dreamspan/shared/macros/catalog.ts"
// Shipped-source allowlist. Never interpret a manifest's base.path as a filesystem path.
const baseCopies = [
  {
    registry: "noticeChannels",
    id: "notifications.completion-sound",
    label: "Completion sound",
    side: "client",
    path: "packages/client/src/features/completionSoundPart.tsx",
    entry: "completionSound",
    files: ["packages/client/src/features/completionSoundPart.tsx", "packages/client/src/features/completionSound.ts"],
    surfaces: ["client:noticeChannels"],
    imports: {
      "packages/client/src/ui/Choice.tsx": "@dreamspan/plugin-api/client",
      "packages/client/src/ui/Surface.tsx": "@dreamspan/plugin-api/client"
    }
  },
  {
    registry: "rolloutTools",
    id: "set_presence",
    label: "Who's present",
    side: "server",
    path: "packages/server/src/agent/tools/presencePart.ts",
    entry: "presencePart",
    files: ["packages/server/src/agent/tools/presencePart.ts"],
    surfaces: ["server:rolloutTools", "server:presence"],
    imports: { "packages/plugin-api/src/server.ts": "@dreamspan/plugin-api/server" }
  }
] as const
const macroCopies = macroParts
  .filter((p) => p.id !== "reverse")
  .map((p) => {
    const path = `packages/shared/src/macros/builtins/${p.source}`
    const family = (
      {
        "utility.ts": "utilityMacros",
        "character.ts": "characterMacros",
        "chat.ts": "chatMacros",
        "variables.ts": "variableMacros",
        "prompts.ts": "promptMacros"
      } as Record<string, string>
    )[p.source]!
    return {
      registry: "macros",
      id: p.id,
      label: `${p.name} macro`,
      side: "worker" as const,
      path,
      entry: family,
      macroName: p.name,
      aliases: [...p.aliases],
      files: [
        path,
        ...(p.source === "utility.ts"
          ? ["packages/shared/src/macros/builtins/reverse.ts"]
          : p.source === "prompts.ts"
            ? ["packages/shared/src/macros/builtins/character.ts"]
            : [])
      ],
      surfaces: ["worker:macros"],
      imports: Object.fromEntries(
        [
          "packages/shared/src/macros/registry.ts",
          "packages/shared/src/macros/context.ts",
          "packages/shared/src/macros/variables.ts",
          "packages/shared/src/macros/expand.ts",
          "packages/shared/src/macros/hash.ts",
          "packages/shared/src/macros/time.ts",
          "packages/plugin-api/src/macros.ts"
        ].map((p) => [p, "@dreamspan/plugin-api/worker"])
      )
    }
  })
const reverseCopy = {
  registry: "macros",
  id: "reverse",
  label: "Reverse text macro",
  side: "worker" as const,
  path: "packages/shared/src/macros/builtins/reverse.ts",
  entry: "reverseMacro",
  files: ["packages/shared/src/macros/builtins/reverse.ts"],
  surfaces: ["worker:macros"],
  imports: { "packages/plugin-api/src/macros.ts": "@dreamspan/plugin-api/worker" }
}
const historyCopies = ["search_chat", "read_messages", "expand_summary", "search_summaries"].map((id, i) => ({
  registry: "rolloutTools",
  id,
  label: ["Search earlier messages", "Read earlier messages", "Open a summary", "Search summaries"][i]!,
  side: "server" as const,
  path: "packages/server/src/agent/tools/historyPart.ts",
  entry: ["searchChat", "readMessages", "expandSummary", "searchSummaries"][i]!,
  files: ["packages/server/src/agent/tools/historyPart.ts"],
  surfaces: ["server:rolloutTools", "server:history"],
  imports: { "packages/plugin-api/src/server.ts": "@dreamspan/plugin-api/server" }
}))
const noteCopies = ["list_notes", "switch_note"].map((id, i) => ({
  registry: "rolloutTools",
  id,
  label: i === 0 ? "List notes" : "Switch a note",
  side: "server" as const,
  path: "packages/server/src/agent/tools/notesPart.ts",
  entry: i === 0 ? "listNotes" : "switchNote",
  files: ["packages/server/src/agent/tools/notesPart.ts"],
  surfaces: ["server:rolloutTools", "server:notes"],
  imports: { "packages/plugin-api/src/server.ts": "@dreamspan/plugin-api/server" }
}))
const displayCopies = [
  ["timelineTransforms", "timeline.merges", "Merged chat rows", "timelineParts.ts", "mergeTimeline"],
  ["timelineTransforms", "timeline.history-budget", "History budget divider", "timelineParts.ts", "historyTimeline"],
  ["timelineTransforms", "timeline.lcm", "Summary rows and divider", "timelineParts.ts", "lcmTimeline"],
  ["timelineTransforms", "timeline.threads", "Parallel thread dividers", "timelineParts.ts", "threadsTimeline"],
  ["displayTransforms", "display.macros", "Display macros", "displayParts.ts", "macroDisplayPart"],
  ["displayTransforms", "display.regex", "Display regex", "displayParts.ts", "regexDisplayPart"],
  [
    "displayScriptLists",
    "display-regex.global",
    "Global display scripts",
    "displayListParts.ts",
    "globalDisplayScripts"
  ],
  [
    "displayScriptLists",
    "display-regex.preset",
    "Preset display scripts",
    "displayListParts.ts",
    "presetDisplayScripts"
  ],
  [
    "displayScriptLists",
    "display-regex.character",
    "Character display scripts",
    "displayListParts.ts",
    "characterDisplayScripts"
  ]
].map(([registry, id, label, file, entry]) => ({
  registry: registry!,
  id: id!,
  label: label!,
  entry: entry!,
  side: "client" as const,
  path: `packages/client/src/features/chat/${file}`,
  files: [`packages/client/src/features/chat/${file}`],
  surfaces: [`client:${registry}`],
  imports: {
    "packages/plugin-api/src/display.ts": "@dreamspan/plugin-api/display",
    "packages/client/src/features/chat/macros.ts": "@dreamspan/plugin-api/display",
    "packages/client/src/features/chat/displayRegex.ts": "@dreamspan/plugin-api/display"
  }
}))
export const builtinCopies = [
  ...baseCopies,
  reverseCopy,
  ...macroCopies,
  ...historyCopies,
  ...noteCopies,
  ...displayCopies
]
export const builtinCopy = (registry: string, id: string) =>
  builtinCopies.find((p) => p.registry === registry && p.id === id)

/** Missing domain adapters, rather than pretending a structural descriptor is copyable. */
export const missingBuiltinAdapter = (id: string): string => {
  if (["search_story", "read_story", "open_story_summary", "search_story_summaries"].includes(id))
    return "Not yet: needs support for choosing the story position and asking before reading it."
  if (id === "read_run") return "Not yet: needs support for reading earlier assistant steps."
  if (["write_note", "edit_note"].includes(id))
    return "Not yet: needs support for safely creating, editing and undoing note changes."
  if (["edit_card", "edit_card_note"].includes(id))
    return "Not yet: needs support for card-note permissions and undoing changes."
  if (id === "lookup_lore") return "Not yet: needs support for looking up lore the character can know."
  if (id.startsWith("plugin_") || id === "app_source")
    return "Not yet: needs support for checking saved code, approving versions and undoing changes."
  if (id.startsWith("read_") || id === "list_library")
    return "Not yet: needs support for reading your saved library items."
  return "Not yet: needs support for approvals and undoing saved changes."
}

/** Keep every supported identity inside the existing tool-result budget. */
export const builtinCopyListing = (
  parts: ReadonlyArray<typeof import("@dreamspan/shared/plugins.ts").BuiltinPart.Type>
) =>
  [...new Set(parts.map((p) => p.registry))].flatMap((registry) =>
    [true, false].flatMap((copyable) => {
      const group = parts.filter((p) => p.registry === registry && p.copyable === copyable)
      return group.length
        ? [
            {
              registry,
              copyable,
              parts: group.map((p) => (copyable ? { id: p.id, label: p.label } : { id: p.id, reason: p.reason }))
            }
          ]
        : []
    })
  )

/** Rendering controls keep their own registrations while data policies become copyable. */
export const unavailableDisplayBodies = [
  ["merge", "Merged chat rendering"],
  ["history", "History budget notice"],
  ["lcm-boundary", "Summary boundary rendering"],
  ["summary", "Summary rendering"],
  ["threads", "Thread divider rendering"]
].map(([id, label]) => ({
  registry: "timelineBodies",
  id: id!,
  label: label!,
  copyable: false,
  reason: "Not yet: needs support for changing the message and summary controls.",
  replacedBy: []
}))
