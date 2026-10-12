// Context assembly and rebuilding in the reader workers (ARCHITECTURE §15).
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeAssembler } from "../assembler/assembler.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import { ASSEMBLER_VERSION, AssemblyFailed, type ContextSnapshot, generationOf } from "../assembler/types.ts"
import { sqlSources } from "./assemblySources.ts"
import { readDefaults } from "./generationSettings.ts"
import type { ReadOps } from "./ops.ts"
import { query } from "./tx.ts"

export const makeAssemblyReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const assembler = yield* makeAssembler
  const handlers = {
    AssembleContext: ({ userId, chatId, slotId, versionId, now, timeZone, frozen }) =>
      Effect.suspend(() => {
        const sources = sqlSources(sql, { userId, chatId, slotId, versionId })
        return assembler.assemble({ now, timeZone, frozen: frozen ?? {}, random: Math.random }).pipe(
          Effect.provide(sources.layer),
          Effect.map((built) => {
            const snapshot: ContextSnapshot = { ...built, sources: sources.pins() }
            return { snapshot: JSON.stringify(snapshot), generation: JSON.stringify(generationOf(snapshot)) }
          })
        )
      }).pipe(query("AssembleContext")),

    RebuildContext: ({ userId, snapshot: json }) =>
      Effect.gen(function* () {
        const taken = JSON.parse(json) as ContextSnapshot
        if ((taken.assemblerVersion ?? 0) !== ASSEMBLER_VERSION) {
          return {
            _tag: "EarlierAssemblerVersion" as const,
            assemblerVersion: taken.assemblerVersion ?? 0,
            currentVersion: ASSEMBLER_VERSION,
            storedSnapshot: json
          }
        }
        if (!taken.sources) {
          return yield* new AssemblyFailed({
            reason: "invalid_document",
            message: "The context can't be built again: it was taken before contexts pinned what they read."
          })
        }
        const { inputs } = taken
        const sources = sqlSources(
          sql,
          { userId, chatId: inputs.chatId as ChatId, slotId: inputs.slotId, versionId: inputs.versionId },
          { pins: taken.sources, inputs }
        )
        const built = yield* assembler
          .assemble({ now: inputs.now, timeZone: inputs.timeZone, frozen: taken.frozen, random: Math.random })
          .pipe(Effect.provide(sources.layer))
        return { _tag: "Rebuilt" as const, snapshot: JSON.stringify({ ...built, sources: sources.pins() }) }
      }).pipe(query("RebuildContext")),

    GetGenerationDefaults: ({ userId }) => readDefaults(sql, userId).pipe(query("GetGenerationDefaults"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
