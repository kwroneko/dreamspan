// All settings use this registry and writer; feature handlers keep their ownership checks.
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { makeRegistry } from "@rp/shared/registry.ts"
import { DisplayPrefs } from "@rp/shared/chatApi.ts"
import { BinLimits } from "@rp/shared/bin.ts"
import { CostRules } from "@rp/shared/costFormulas.ts"
import { DecisionPointSetting } from "@rp/shared/decisions.ts"
import { LcmDefaults, ModelChoice } from "@rp/shared/lcmSettings.ts"
import { GlobalScripts } from "@rp/shared/regexScripts.ts"
import { StaleWrite } from "@rp/shared/errors.ts"
import { StorageError } from "./ops.ts"

type SettingScope = "app" | "user" | "device"
interface SettingDefinition {
  readonly id: string
  readonly scope: SettingScope
  readonly schema: Schema.Top
}

const definitions: ReadonlyArray<SettingDefinition> = [
  {
    id: "network",
    scope: "app",
    schema: Schema.Struct({
      proxyUrlEnc: Schema.NullOr(Schema.String),
      bypass: Schema.Array(Schema.String),
      forceProxy: Schema.optionalKey(Schema.Boolean)
    })
  },
  { id: "display", scope: "user", schema: DisplayPrefs },
  { id: "notices", scope: "user", schema: Schema.Record(Schema.String, Schema.Array(Schema.String)) },
  { id: "shell.pinsCollapsed", scope: "user", schema: Schema.Boolean },
  { id: "cost", scope: "user", schema: CostRules },
  { id: "chat.persona", scope: "user", schema: Schema.NullOr(Schema.String) },
  { id: "generation.model", scope: "user", schema: Schema.NullOr(ModelChoice) },
  { id: "generation.preset", scope: "user", schema: Schema.NullOr(Schema.String) },
  { id: "generation.judge", scope: "user", schema: Schema.NullOr(ModelChoice) },
  { id: "generation.lcm", scope: "user", schema: Schema.NullOr(LcmDefaults) },
  { id: "regex.global", scope: "user", schema: GlobalScripts },
  { id: "bin.limits", scope: "user", schema: BinLimits },
  {
    id: "cards.favourites",
    scope: "user",
    schema: Schema.Struct({ on: Schema.Array(Schema.String), here: Schema.Array(Schema.String) })
  },
  {
    id: "token_counting",
    scope: "user",
    schema: Schema.Struct({ connections: Schema.Record(Schema.String, Schema.String) })
  },
  {
    id: "decisions",
    scope: "user",
    schema: Schema.Struct({
      connections: Schema.Record(
        Schema.String,
        Schema.Struct({
          model: Schema.NullOr(Schema.String),
          points: Schema.Record(Schema.String, DecisionPointSetting)
        })
      )
    })
  },
  {
    id: "import.st.memory",
    scope: "user",
    schema: Schema.Struct({
      prompt: Schema.NullOr(Schema.String),
      promptWords: Schema.Number,
      position: Schema.Number,
      depth: Schema.Number,
      role: Schema.Number,
      template: Schema.String,
      enabled: Schema.Boolean
    })
  },
  {
    id: "workbench",
    scope: "device",
    schema: Schema.Struct({ at: Schema.Int, layout: Schema.Record(Schema.String, Schema.Unknown) })
  }
]

const accepts = (definition: SettingDefinition) => Schema.is(definition.schema as Schema.Schema<unknown>)
const entries = makeRegistry(definitions.map((definition) => ({ ...definition, accepts: accepts(definition) })))

/** Plugins add, replace or disable keys with scoped registrations, also inside workers. */
export const settingsRegistry = {
  ...entries,
  register: (definition: SettingDefinition, validate = accepts(definition)) =>
    entries.register({ ...definition, accepts: validate })
}

// Device ids are browser-generated. Pair with the account to isolate shared browsers/accounts.
export const deviceScopeId = (userId: string, device: string) => JSON.stringify([userId, device])

export const readSetting = (sql: SqlClient.SqlClient, scope: SettingScope, scopeId: string, key: string) =>
  sql<{ value_json: string; revision: number }>`SELECT value_json, revision FROM settings
    WHERE scope = ${scope} AND scope_id = ${scopeId} AND key = ${key}`.pipe(
    Effect.map(([row]) => ({
      value: row ? (JSON.parse(row.value_json) as unknown) : null,
      revision: row?.revision ?? 0
    }))
  )

/** Must run in the caller's writer transaction; patches read/merge there, replacements pass a revision. */
export const writeSetting = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  scope: SettingScope,
  scopeId: string,
  key: string,
  value: unknown,
  expectedRevision?: number
) {
  const definition = settingsRegistry.get(key)
  if (!definition || definition.scope !== scope || !definition.accepts(value))
    return yield* new StorageError({
      operation: "writeSetting",
      reason: "constraint",
      message: `Invalid ${scope} setting: ${key}`
    })
  const stored = yield* readSetting(sql, scope, scopeId, key)
  if (expectedRevision !== undefined && stored.revision !== expectedRevision)
    return yield* new StaleWrite({
      entity: "setting",
      id: `${scope}/${scopeId}/${key}`,
      expected: expectedRevision,
      actual: stored.revision
    })
  const revision = stored.revision + 1
  yield* sql`INSERT INTO settings (scope, scope_id, key, value_json, revision, updated_at)
    VALUES (${scope}, ${scopeId}, ${key}, ${JSON.stringify(value)}, ${revision}, ${Date.now()})
    ON CONFLICT (scope, scope_id, key) DO UPDATE SET value_json = excluded.value_json,
      revision = excluded.revision, updated_at = excluded.updated_at`
  return revision
})

/** Atomic patches have no stale caller snapshot; their read and write share the transaction. */
export const putUserSetting = (sql: SqlClient.SqlClient, userId: string, key: string, value: unknown) =>
  writeSetting(sql, "user", userId, key, value).pipe(Effect.catchTag("StaleWrite", Effect.die))
