import { Context, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { PluginPins, PluginRejected } from "@rp/shared/plugins.ts"
import { StaleWrite } from "@rp/shared/errors.ts"
import { query, transaction } from "./tx.ts"
import { readSetting, writeSetting } from "./settings.ts"
import type { ReadOps, WriteOps } from "./ops.ts"
import type { OpsOf } from "./opsOf.ts"
import type { Rpc } from "effect/rpc"

type Handlers<G> = {
  [R in OpsOf<G> as R["_tag"]]: (
    input: Rpc.Payload<R>
  ) => Effect.Effect<Rpc.Success<R>, Rpc.Error<R>, SqlClient.SqlClient>
}
/** Set only by the installed worker bridge, never by a public payload. */
export const PluginDataGrant = Context.Reference<{ readonly pluginId: string; readonly owner: string } | null>(
  "rp/plugins/DataGrant",
  { defaultValue: () => null }
)
const authorize = (
  sql: SqlClient.SqlClient,
  userId: string,
  owner: string,
  pluginId?: string,
  readPins = false,
  managePins = false
) =>
  Effect.gen(function* () {
    const grant = yield* PluginDataGrant
    if (pluginId && grant?.pluginId === pluginId && grant.owner === owner) return
    const [actor] = yield* sql<{
      role: string
      disabled_at: number | null
    }>`SELECT role, disabled_at FROM users WHERE id = ${userId}`
    if (
      !actor ||
      actor.disabled_at !== null ||
      (owner !== userId &&
        !(owner === "" && (actor.role === "admin" || readPins)) &&
        !(managePins && actor.role === "admin"))
    )
      return yield* new PluginRejected({ message: "Plugin data is unavailable" })
  })
const checkKey = (key: string) => key.length > 0 && key.length <= 200 && !key.includes("\0")
interface DataRow {
  key: string
  value_json: string
  revision: number
  updated_at: number
}
const dataView = (row: DataRow) => ({
  key: row.key,
  value: JSON.parse(row.value_json) as unknown,
  revision: row.revision,
  updatedAt: row.updated_at
})
export const makePluginReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    GetPluginPins: ({ userId, owner }) =>
      Effect.gen(function* () {
        yield* authorize(sql, userId, owner, undefined, true, true)
        const stored = yield* readSetting(
          sql,
          owner ? "user" : "app",
          owner,
          owner ? "plugins.user" : "plugins.instance"
        )
        return { value: Schema.decodeUnknownSync(PluginPins)(stored.value ?? {}), revision: stored.revision }
      }).pipe(query("GetPluginPins")),
    AllPluginPins: () =>
      Effect.gen(function* () {
        const rows = yield* sql<{ scope_id: string; value_json: string }>`SELECT scope_id, value_json FROM settings
        WHERE (scope = 'app' AND key = 'plugins.instance') OR (scope = 'user' AND key = 'plugins.user')`
        return rows.map((row) => ({
          owner: row.scope_id,
          value: Schema.decodeUnknownSync(PluginPins)(JSON.parse(row.value_json))
        }))
      }).pipe(query("AllPluginPins")),
    GetPluginData: ({ userId, pluginId, owner, key }) =>
      Effect.gen(function* () {
        yield* authorize(sql, userId, owner, pluginId)
        const [row] = yield* sql<DataRow>`SELECT key, value_json, revision, updated_at FROM plugin_data
        WHERE plugin_id = ${pluginId} AND owner_user_id = ${owner} AND key = ${key}`
        return row ? dataView(row) : null
      }).pipe(query("GetPluginData")),
    PluginDataInfo: ({ userId, pluginId, owner }) =>
      Effect.gen(function* () {
        yield* authorize(sql, userId, owner, pluginId)
        return yield* sql<{ key: string; bytes: number }>`SELECT key, length(CAST(value_json AS BLOB)) AS bytes
          FROM plugin_data WHERE plugin_id = ${pluginId} AND owner_user_id = ${owner} ORDER BY key LIMIT 1000`
      }).pipe(query("PluginDataInfo")),
    ListPluginData: ({ userId, pluginId, owner }) =>
      Effect.gen(function* () {
        yield* authorize(sql, userId, owner, pluginId)
        const rows = yield* sql<DataRow>`SELECT key, value_json, revision, updated_at FROM plugin_data
        WHERE plugin_id = ${pluginId} AND owner_user_id = ${owner} ORDER BY key LIMIT 1000`
        return rows.map(dataView)
      }).pipe(query("ListPluginData"))
  } satisfies Pick<
    Handlers<typeof ReadOps>,
    "GetPluginPins" | "AllPluginPins" | "GetPluginData" | "ListPluginData" | "PluginDataInfo"
  >
})
export const makePluginWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SetPluginPins: ({ userId, owner, value, revision }) =>
      Effect.gen(function* () {
        yield* authorize(sql, userId, owner, undefined, false, true)
        yield* writeSetting(
          sql,
          owner ? "user" : "app",
          owner,
          owner ? "plugins.user" : "plugins.instance",
          value,
          revision
        )
      }).pipe(transaction(sql, "SetPluginPins"), Effect.asVoid),
    SetPluginData: ({ userId, pluginId, owner, key, value, revision }) =>
      Effect.gen(function* () {
        yield* authorize(sql, userId, owner, pluginId)
        const encoded = JSON.stringify(value)
        if (!checkKey(key) || encoded === undefined || Buffer.byteLength(encoded) > 524288)
          return yield* new PluginRejected({ message: "Invalid plugin data" })
        const [usage] = yield* sql<{ count: number; bytes: number }>`SELECT count(*) AS count,
          coalesce(sum(length(CAST(value_json AS BLOB))), 0) AS bytes FROM plugin_data
          WHERE plugin_id = ${pluginId} AND owner_user_id = ${owner} AND key <> ${key}`
        if (usage!.count >= 1000 || usage!.bytes + Buffer.byteLength(encoded) > 8 * 1024 * 1024)
          return yield* new PluginRejected({ message: "Plugin storage quota exceeded" })
        const [previous] = yield* sql<{
          revision: number
        }>`SELECT revision FROM plugin_data WHERE plugin_id = ${pluginId} AND owner_user_id = ${owner} AND key = ${key}`
        if ((previous?.revision ?? 0) !== revision)
          return yield* new StaleWrite({
            entity: "plugin data",
            id: key,
            expected: revision,
            actual: previous?.revision ?? 0
          })
        yield* sql`INSERT INTO plugin_data (plugin_id,owner_user_id,key,value_json,revision,updated_at)
        VALUES (${pluginId},${owner},${key},${encoded},${revision + 1},${Date.now()})
        ON CONFLICT (plugin_id,owner_user_id,key) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision,updated_at=excluded.updated_at`
      }).pipe(transaction(sql, "SetPluginData")),
    DeletePluginData: ({ userId, pluginId, owner, key, revision }) =>
      Effect.gen(function* () {
        yield* authorize(sql, userId, owner, pluginId)
        if (key === null) {
          yield* sql`DELETE FROM plugin_data WHERE plugin_id = ${pluginId} AND owner_user_id = ${owner}`
          return
        }
        const rows =
          yield* sql`DELETE FROM plugin_data WHERE plugin_id = ${pluginId} AND owner_user_id = ${owner} AND key = ${key} AND revision = ${revision} RETURNING key`
        if (!rows.length)
          return yield* new StaleWrite({ entity: "plugin data", id: key, expected: revision, actual: 0 })
      }).pipe(transaction(sql, "DeletePluginData"))
  } satisfies Pick<Handlers<typeof WriteOps>, "SetPluginPins" | "SetPluginData" | "DeletePluginData">
})
