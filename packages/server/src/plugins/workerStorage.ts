// Calls the typed storage operations using the worker's SQL service, captured before activation.
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { UserId } from "@rp/shared/domain.ts"
import { PluginRejected } from "@rp/shared/plugins.ts"
import type { PrivateStorage } from "../../../plugin-api/src/common.ts"
import { makePluginReadHandlers, makePluginWriteHandlers, PluginDataGrant } from "../db/pluginData.ts"
export const workerStorage = (pluginId: string): Effect.Effect<PrivateStorage> =>
  Effect.gen(function* () {
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient)
    const input = { pluginId, owner: "", userId: "" as UserId }
    const granted = <A, E>(operation: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Option.isNone(sql)
        ? Effect.fail(new PluginRejected({ message: "Storage is available inside worker handlers" }))
        : operation.pipe(
            Effect.provideService(SqlClient.SqlClient, sql.value),
            Effect.provideService(PluginDataGrant, { pluginId, owner: "" }),
            Effect.catchCause(() =>
              Effect.fail(new PluginRejected({ message: "Plugin worker storage operation failed" }))
            )
          )
    return Object.freeze({
      get: (key: string) =>
        granted(Effect.flatMap(makePluginReadHandlers, (ops) => ops.GetPluginData({ ...input, key }))),
      list: () => granted(Effect.flatMap(makePluginReadHandlers, (ops) => ops.ListPluginData(input))),
      set: (key: string, value: unknown, revision: number) =>
        granted(
          Effect.flatMap(makePluginWriteHandlers, (ops) => ops.SetPluginData({ ...input, key, value, revision }))
        ),
      delete: (key: string, revision: number) =>
        granted(Effect.flatMap(makePluginWriteHandlers, (ops) => ops.DeletePluginData({ ...input, key, revision })))
    })
  })
