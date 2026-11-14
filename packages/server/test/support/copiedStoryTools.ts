// Exercise shipped editable policies through real declared replacement handles.
import { Effect } from "effect"
import { makeRegistry } from "@rp/shared/registry.ts"
import { declaredHandles } from "../../src/plugins/handles.ts"
import type { RolloutTool } from "../../src/agent/tools.ts"
import { historyTools } from "../../src/agent/tools/history.ts"
import { listNotes, switchNote } from "../../src/agent/tools/notes.ts"
import { setPresence } from "../../src/agent/tools/presence.ts"
import { searchChat, readMessages, expandSummary, searchSummaries } from "../../src/agent/tools/historyPart.ts"
import { listNotes as listPart, switchNote as switchPart } from "../../src/agent/tools/notesPart.ts"
import { presencePart } from "../../src/agent/tools/presencePart.ts"

export const copiedStoryTools = Effect.gen(function* () {
  const registry = makeRegistry<RolloutTool<never>>([...historyTools, listNotes, switchNote, setPresence])
  const handles = declaredHandles(
    {
      id: "privacy-copies",
      name: "Privacy copies",
      api: 1,
      server: "server.ts",
      worker: null,
      client: null,
      surfaces: ["server:rolloutTools", "server:history", "server:notes", "server:presence"],
      replaces: registry.list().map((tool) => `rolloutTools:${tool.id}`),
      overrides: [],
      network: false,
      base: null
    },
    "server",
    { rolloutTools: registry },
    yield* Effect.scope,
    new Map(),
    () => {
      throw new Error("Copied privacy tool failed")
    }
  ) as { rolloutTools: { register: (entry: unknown) => Effect.Effect<void, unknown> } }
  for (const part of [searchChat, readMessages, expandSummary, searchSummaries, listPart, switchPart, presencePart])
    yield* handles.rolloutTools.register(part).pipe(Effect.orDie)
  return registry.list()
})
