import { macroParts } from "@rp/shared/macros/catalog.ts"
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
      "packages/client/src/ui/Choice.tsx": "@rp/plugin-api/client",
      "packages/client/src/ui/Surface.tsx": "@rp/plugin-api/client"
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
    imports: { "packages/plugin-api/src/server.ts": "@rp/plugin-api/server" }
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
        ].map((p) => [p, "@rp/plugin-api/worker"])
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
  imports: { "packages/plugin-api/src/macros.ts": "@rp/plugin-api/worker" }
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
  imports: { "packages/plugin-api/src/server.ts": "@rp/plugin-api/server" }
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
  imports: { "packages/plugin-api/src/server.ts": "@rp/plugin-api/server" }
}))
export const builtinCopies = [...baseCopies, reverseCopy, ...macroCopies, ...historyCopies, ...noteCopies]
export const builtinCopy = (registry: string, id: string) =>
  builtinCopies.find((p) => p.registry === registry && p.id === id)

/** Missing domain adapters, rather than pretending a structural descriptor is copyable. */
export const missingBuiltinAdapter = (id: string): string => {
  if (["search_story", "read_story", "open_story_summary", "search_story_summaries"].includes(id))
    return "Not yet: needs the story position, quoted results and ask-first adapter."
  if (id === "read_run") return "Not yet: needs the run transcript and compacted-step visibility adapter."
  if (["write_note", "edit_note"].includes(id))
    return "Not yet: needs note creation and revision checks, permissions and reversible receipts."
  if (["edit_card", "edit_card_note"].includes(id))
    return "Not yet: needs card-note permissions, revision snapshots and reversible receipts."
  if (id === "lookup_lore") return "Not yet: needs the causal lore activation and entry-visibility adapter."
  if (id.startsWith("plugin_") || id === "app_source")
    return "Not yet: needs confined repositories, role checks, exact-version consent and Undo."
  if (id.startsWith("read_") || id === "list_library")
    return "Not yet: needs owned library reads and document rendering."
  return "Not yet: needs owned library or chat changes, approval snapshots, receipts and Undo."
}

/** Keep every supported identity inside the existing tool-result budget. */
export const builtinCopyListing = (parts: ReadonlyArray<typeof import("@rp/shared/plugins.ts").BuiltinPart.Type>) =>
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
