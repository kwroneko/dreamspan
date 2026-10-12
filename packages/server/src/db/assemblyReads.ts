// Context assembly in the reader workers (ARCHITECTURE §13): the assembler's stages run over
// the database in one read transaction, off the main thread. Each reader keeps one
// assembler, with its built-in stages and macros, for its lifetime.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeAssembler } from "../assembler/assembler.ts"
import { generationOf } from "../assembler/types.ts"
import { sqlSources } from "./assemblySources.ts"
import { readDefaults } from "./generationSettings.ts"
import type { ReadOps } from "./ops.ts"
import { query } from "./tx.ts"

export const makeAssemblyReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const assembler = yield* makeAssembler
  const handlers = {
    AssembleContext: ({ userId, chatId, slotId, versionId, now, timeZone, frozen }) =>
      assembler.assemble({ now, timeZone, frozen: frozen ?? {}, random: Math.random }).pipe(
        Effect.provide(sqlSources(sql, { userId, chatId, slotId, versionId })),
        Effect.map((snapshot) => ({
          snapshot: JSON.stringify(snapshot),
          generation: JSON.stringify(generationOf(snapshot))
        })),
        query("AssembleContext")
      ),

    GetGenerationDefaults: ({ userId }) => readDefaults(sql, userId).pipe(query("GetGenerationDefaults"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
