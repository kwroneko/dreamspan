import { macroParts } from "@dreamspan/shared/macros/catalog.ts"
import type { BuiltinPart } from "@dreamspan/shared/plugins.ts"
import { FILE_TOOLS } from "../agent/tools/files.ts"
import { toolData, TOOL_RESULT_CHARS } from "../agent/toolData.ts"
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
const subagentTypeCopies = [
  ["research", "Look things up (subagent type)", "researchType"],
  ["code", "Work on files (subagent type)", "codeType"],
  ["general", "Work on part of the task (subagent type)", "generalType"]
].map(([id, label, entry]) => ({
  registry: "subagentTypes",
  id: id!,
  label: label!,
  side: "server" as const,
  path: "packages/server/src/agent/subagentTypesPart.ts",
  entry: entry!,
  files: ["packages/server/src/agent/subagentTypesPart.ts"],
  surfaces: ["server:subagentTypes"],
  imports: { "packages/plugin-api/src/server.ts": "@dreamspan/plugin-api/server" }
}))
export const builtinCopies = [
  ...baseCopies,
  ...subagentTypeCopies,
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
  if (id === "import_card_file")
    return "Copying this tool needs support for importing cards into your library with your approval."
  if (["bash", "bash_output", "bash_stop"].includes(id))
    return "Copying this tool needs support for running and managing background commands."
  // Before the read_ rule: read_file and read_card_file read the user's files, not the library.
  if ((FILE_TOOLS as ReadonlyArray<string>).includes(id))
    return "Not yet: needs support for working in your files and undoing file changes."
  if (id.startsWith("read_") || id === "list_library" || id === "diff_revisions")
    return "Not yet: needs support for reading your saved library items."
  return "Not yet: needs support for approvals and undoing saved changes."
}

const builtinCopyGroups = (registry: string, parts: ReadonlyArray<typeof BuiltinPart.Type>) => {
  const available = parts.filter((part) => part.copyable).map(({ id, label }) => ({ id, label }))
  const unavailable = Map.groupBy(
    parts.filter((part) => !part.copyable),
    (part) => part.reason
  )
  return [
    ...(available.length ? [{ registry, copyable: true as const, parts: available }] : []),
    ...[...unavailable].map(([reason, rows]) => ({
      registry,
      copyable: false as const,
      reason,
      ids: rows.map((part) => part.id)
    }))
  ]
}

export interface BuiltinCopyCatalogPage {
  readonly groups: ReturnType<typeof builtinCopyGroups>
  readonly nextRegistry: string | null
}

/** Page at registry boundaries using the size of the quoted result sent to the model. */
export const builtinCopyPage = (parts: ReadonlyArray<typeof BuiltinPart.Type>, fromRegistry?: string) => {
  const registries = [...Map.groupBy(parts, (part) => part.registry)]
  const start = fromRegistry === undefined ? 0 : registries.findIndex(([registry]) => registry === fromRegistry)
  if (start < 0) return undefined
  const encode = (page: BuiltinCopyCatalogPage) => toolData(JSON.stringify(page))
  let groups: BuiltinCopyCatalogPage["groups"] = []
  let text: string | undefined
  for (let index = start; index < registries.length; index++) {
    const [registry, rows] = registries[index]!
    const combined = [...groups, ...builtinCopyGroups(registry, rows)]
    const candidate = encode({ groups: combined, nextRegistry: registries[index + 1]?.[0] ?? null })
    if (candidate.length > TOOL_RESULT_CHARS) return text
    groups = combined
    text = candidate
  }
  return text ?? encode({ groups: [], nextRegistry: null })
}

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
