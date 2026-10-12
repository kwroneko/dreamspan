// Context assembly in the reader workers (ARCHITECTURE §13): the assembler's stages run over
// the database in one read transaction, off the main thread. Each reader keeps one
// assembler, with its built-in stages and macros, for its lifetime.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeAssembler } from "../assembler/assembler.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import { AssemblyFailed, type ContextSnapshot, generationOf } from "../assembler/types.ts"
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
      Effect.suspend(() => {
        const taken = JSON.parse(json) as ContextSnapshot
        if (!taken.sources) {
          return Effect.fail(
            new AssemblyFailed({
              reason: "invalid_document",
              message: "The context can't be built again: it was taken before contexts pinned what they read."
            })
          )
        }
        const { inputs } = taken
        const sources = sqlSources(
          sql,
          { userId, chatId: inputs.chatId as ChatId, slotId: inputs.slotId, versionId: inputs.versionId },
          { pins: taken.sources, inputs }
        )
        return assembler
          .assemble({ now: inputs.now, timeZone: inputs.timeZone, frozen: taken.frozen, random: Math.random })
          .pipe(
            Effect.provide(sources.layer),
            Effect.map((built) => ({ snapshot: JSON.stringify({ ...built, sources: sources.pins() }) }))
          )
      }).pipe(query("RebuildContext")),

    GetGenerationDefaults: ({ userId }) => readDefaults(sql, userId).pipe(query("GetGenerationDefaults"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
