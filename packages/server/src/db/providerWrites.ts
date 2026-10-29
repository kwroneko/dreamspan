import { admitRequest } from "./lcmBackfill.ts"
// Connection, model and ledger write handlers (spec/PROVIDERS.md §2, §3, §9). They run
// in the writer worker, each as one transaction. Secrets arrive already encrypted.
import { uuidv7 } from "@rp/shared/id.ts"
import type { ConnectionSettings } from "@rp/shared/providers.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { ModelKeyTaken, NotFound, StaleWrite, WriteOps } from "./ops.ts"
import {
  connectionColumns,
  connectionFrom,
  type ConnectionRow,
  credentialColumns,
  type CredentialRow,
  makeProviderQueries,
  type ModelRow,
  toConnection,
  toCredential,
  toModel
} from "./providers.ts"
import { transaction } from "./tx.ts"

const settingsColumns = (settings: ConnectionSettings) => ({
  name: settings.name,
  base_url: settings.baseUrl,
  compat_json: JSON.stringify(settings.compat),
  cache_ttl_s: settings.cacheTtlS,
  max_concurrent: settings.maxConcurrent,
  preset_override_ref_id: settings.presetOverrideRefId
})

export const makeProviderWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { ownedConnection, ownedModel, ownedCredential } = makeProviderQueries(sql)

  const reloadConnection = (id: string) =>
    sql<ConnectionRow>`SELECT ${sql.literal(connectionColumns)} FROM ${sql.literal(connectionFrom)} WHERE c.id = ${id}`.pipe(
      Effect.map(([row]) => toConnection(row!))
    )
  const reloadCredential = (id: string) =>
    sql<CredentialRow>`SELECT ${sql.literal(credentialColumns)} FROM credentials cr WHERE cr.id = ${id}`.pipe(
      Effect.map(([row]) => toCredential(row!))
    )
  /** A credential that exists and is the user's, or NotFound. */
  const checkCredential = (userId: UserId, credentialId: string | null) =>
    credentialId === null ? Effect.void : Effect.asVoid(ownedCredential(userId, credentialId))
  const reloadModel = (id: string) =>
    sql<ModelRow>`SELECT * FROM models WHERE id = ${id}`.pipe(Effect.map(([row]) => toModel(row!)))

  /** Changes a connection's secret columns; bumps the row version so other tabs see it. */
  const setSecrets = (userId: UserId, connectionId: string, columns: Record<string, unknown>) =>
    Effect.gen(function* () {
      yield* ownedConnection(userId, connectionId)
      yield* sql`UPDATE connections SET ${sql.update({ ...columns, updated_at: Date.now() })},
                   row_version = row_version + 1
                 WHERE id = ${connectionId}`
      return yield* reloadConnection(connectionId)
    })

  /**
   * A preset override must be one of the user's own live refs. Without this check a
   * connection could point at another user's preset (and probe whether a ref id exists).
   */
  const checkPresetRef = (userId: UserId, refId: string | null) =>
    refId === null
      ? Effect.void
      : sql`SELECT 1 FROM entity_refs r JOIN entities e ON e.id = r.entity_id
            WHERE r.id = ${refId} AND e.owner_user_id = ${userId} AND e.deleted_at IS NULL AND e.purged_at IS NULL`.pipe(
          Effect.flatMap(([row]) => (row ? Effect.void : Effect.fail(new NotFound({ entity: "ref", id: refId }))))
        )

  const insertCredential = (
    userId: UserId,
    credential: {
      readonly credentialId: string
      readonly name: string
      readonly key: { readonly enc: Uint8Array; readonly hint: string }
      readonly origins: ReadonlyArray<string>
    },
    connectionOwned: boolean
  ) => {
    const now = Date.now()
    return sql`INSERT INTO credentials ${sql.insert({
      id: credential.credentialId,
      owner_user_id: userId,
      name: credential.name,
      key_enc: credential.key.enc,
      key_hint: credential.key.hint,
      origins_json: JSON.stringify([...new Set(credential.origins)]),
      connection_owned: connectionOwned ? 1 : 0,
      created_at: now,
      updated_at: now
    })}`
  }

  /** Optimistic concurrency on a model's edits. */
  const modelAt = (userId: UserId, modelId: string, expected: number) =>
    Effect.gen(function* () {
      const row = yield* ownedModel(userId, modelId)
      if (row.row_version !== expected) {
        return yield* new StaleWrite({ entity: "model", id: modelId, expected, actual: row.row_version })
      }
      return row
    })

  const handlers = {
    SetCostSettings: ({ userId, expectedRevision, rules }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ revision: number }>`SELECT revision FROM cost_settings WHERE user_id = ${userId}`
        const actual = row?.revision ?? 0
        if (actual !== expectedRevision)
          return yield* new StaleWrite({ entity: "cost settings", id: userId, expected: expectedRevision, actual })
        for (const rule of rules) if (rule.connectionId !== null) yield* ownedConnection(userId, rule.connectionId)
        const revision = actual + 1
        yield* sql`INSERT INTO cost_settings(user_id, revision, rules_json) VALUES (${userId}, ${revision}, ${JSON.stringify(rules)}) ON CONFLICT(user_id) DO UPDATE SET revision = excluded.revision, rules_json = excluded.rules_json`
        return { revision, rules }
      }).pipe(transaction(sql, "SetCostSettings")),
    CreateConnection: ({ userId, connectionId, kind, api, settings, credential }) =>
      Effect.gen(function* () {
        yield* checkPresetRef(userId, settings.presetOverrideRefId)
        const credentialId = "typed" in credential ? credential.typed.credentialId : credential.existing
        if ("typed" in credential) yield* insertCredential(userId, credential.typed, true)
        else yield* checkCredential(userId, credentialId)
        const now = Date.now()
        yield* sql`INSERT INTO connections ${sql.insert({
          id: connectionId,
          owner_user_id: userId,
          kind,
          api,
          ...settingsColumns(settings),
          credential_id: credentialId,
          created_at: now,
          updated_at: now
        })}`
        return yield* reloadConnection(connectionId)
      }).pipe(transaction(sql, "CreateConnection")),

    UpdateConnection: ({ userId, connectionId, settings, expectedRowVersion }) =>
      Effect.gen(function* () {
        const row = yield* ownedConnection(userId, connectionId)
        yield* checkPresetRef(userId, settings.presetOverrideRefId)
        if (row.row_version !== expectedRowVersion) {
          return yield* new StaleWrite({
            entity: "connection",
            id: connectionId,
            expected: expectedRowVersion,
            actual: row.row_version
          })
        }
        yield* sql`UPDATE connections SET ${sql.update({ ...settingsColumns(settings), updated_at: Date.now() })},
                     row_version = row_version + 1
                   WHERE id = ${connectionId}`
        return yield* reloadConnection(connectionId)
      }).pipe(transaction(sql, "UpdateConnection")),

    SetConnectionKey: ({ userId, connectionId, expectedRowVersion, credential }) =>
      Effect.gen(function* () {
        const row = yield* ownedConnection(userId, connectionId)
        if (row.row_version !== expectedRowVersion) {
          return yield* new StaleWrite({
            entity: "connection",
            id: connectionId,
            expected: expectedRowVersion,
            actual: row.row_version
          })
        }
        if (credential) yield* insertCredential(userId, credential, true)
        const updated = yield* setSecrets(userId, connectionId, { credential_id: credential?.credentialId ?? null })
        if (row.credential_id !== null) {
          yield* sql`DELETE FROM credentials WHERE id = ${row.credential_id} AND connection_owned = 1
            AND NOT EXISTS (SELECT 1 FROM connections WHERE credential_id = ${row.credential_id})`
        }
        return updated
      }).pipe(transaction(sql, "SetConnectionKey")),

    SetConnectionCredential: ({ userId, connectionId, credentialId }) =>
      Effect.gen(function* () {
        yield* checkCredential(userId, credentialId)
        return yield* setSecrets(userId, connectionId, { credential_id: credentialId })
      }).pipe(transaction(sql, "SetConnectionCredential")),

    CreateCredential: ({ userId, credentialId, name, key, origins }) =>
      insertCredential(userId, { credentialId, name, key, origins }, false).pipe(
        Effect.andThen(reloadCredential(credentialId)),
        transaction(sql, "CreateCredential")
      ),

    RenameCredential: ({ userId, credentialId, name }) =>
      Effect.gen(function* () {
        yield* ownedCredential(userId, credentialId)
        yield* sql`UPDATE credentials SET name = ${name}, updated_at = ${Date.now()}, row_version = row_version + 1
                   WHERE id = ${credentialId}`
        return yield* reloadCredential(credentialId)
      }).pipe(transaction(sql, "RenameCredential")),

    ReplaceCredentialKey: ({ userId, credentialId, key, origins }) =>
      Effect.gen(function* () {
        yield* ownedCredential(userId, credentialId)
        yield* sql`UPDATE credentials SET key_enc = ${key.enc}, key_hint = ${key.hint},
                     origins_json = ${JSON.stringify([...new Set(origins)])}, updated_at = ${Date.now()},
                     row_version = row_version + 1
                   WHERE id = ${credentialId}`
        return yield* reloadCredential(credentialId)
      }).pipe(transaction(sql, "ReplaceCredentialKey")),

    AddCredentialOrigin: ({ userId, credentialId, origin }) =>
      Effect.gen(function* () {
        const row = yield* ownedCredential(userId, credentialId)
        const origins = new Set(JSON.parse(row.origins_json) as Array<string>)
        origins.add(origin)
        yield* sql`UPDATE credentials SET origins_json = ${JSON.stringify([...origins])}, updated_at = ${Date.now()},
                     row_version = row_version + 1
                   WHERE id = ${credentialId}`
        return yield* reloadCredential(credentialId)
      }).pipe(transaction(sql, "AddCredentialOrigin")),

    DeleteCredential: ({ userId, credentialId }) =>
      Effect.gen(function* () {
        yield* ownedCredential(userId, credentialId)
        // Connections using it are left without a key (ON DELETE SET NULL).
        yield* sql`DELETE FROM credentials WHERE id = ${credentialId}`
      }).pipe(transaction(sql, "DeleteCredential")),

    SetConnectionHeaders: ({ userId, connectionId, expectedRowVersion, headers }) =>
      Effect.gen(function* () {
        const row = yield* ownedConnection(userId, connectionId)
        if (row.row_version !== expectedRowVersion) {
          return yield* new StaleWrite({
            entity: "connection",
            id: connectionId,
            expected: expectedRowVersion,
            actual: row.row_version
          })
        }
        return yield* setSecrets(userId, connectionId, {
          headers_enc: headers?.enc ?? null,
          headers_origin: headers?.origin ?? null,
          header_names_json: JSON.stringify(headers?.names ?? [])
        })
      }).pipe(transaction(sql, "SetConnectionHeaders")),

    SetConnectionProxy: ({ userId, connectionId, mode, urlEnc }) =>
      setSecrets(userId, connectionId, { proxy_mode: mode, proxy_url_enc: mode === "custom" ? urlEnc : null }).pipe(
        transaction(sql, "SetConnectionProxy")
      ),

    SyncFetchedModels: ({ userId, connectionId, models, fetchedAt }) =>
      Effect.gen(function* () {
        yield* ownedConnection(userId, connectionId)
        const existing = yield* sql<{ id: string; model_key: string; fetched_at: number | null }>`
          SELECT id, model_key, fetched_at FROM models WHERE connection_id = ${connectionId}`
        const byKey = new Map(existing.map((row) => [row.model_key, row]))
        // An upstream may list a key twice; the last entry wins.
        const unique = [...new Map(models.map((model) => [model.key, model])).values()]
        let added = 0
        let updated = 0
        for (const model of unique) {
          const known = byKey.get(model.key)
          const upstream = JSON.stringify(model.upstream)
          if (known) {
            yield* sql`UPDATE models SET upstream_json = ${upstream}, fetched_at = ${fetchedAt}, missing_since = NULL
                       WHERE id = ${known.id}`
            updated++
          } else {
            yield* sql`INSERT INTO models ${sql.insert({
              id: uuidv7(),
              connection_id: connectionId,
              model_key: model.key,
              source: "fetched",
              upstream_json: upstream,
              fetched_at: fetchedAt,
              created_at: fetchedAt
            })}`
            added++
          }
        }
        // Models the list stopped reporting are marked, never deleted: versions and the
        // ledger refer to them. Models only ever added by hand were never listed.
        const listed = new Set(unique.map((model) => model.key))
        let missing = 0
        for (const row of existing) {
          if (listed.has(row.model_key) || row.fetched_at === null) continue
          yield* sql`UPDATE models SET missing_since = coalesce(missing_since, ${fetchedAt}) WHERE id = ${row.id}`
          missing++
        }
        return { added, updated, missing }
      }).pipe(transaction(sql, "SyncFetchedModels")),

    AddUserModel: ({ userId, connectionId, key, overrides }) =>
      Effect.gen(function* () {
        yield* ownedConnection(userId, connectionId)
        const [taken] = yield* sql`SELECT 1 FROM models WHERE connection_id = ${connectionId} AND model_key = ${key}`
        if (taken) return yield* new ModelKeyTaken({ connectionId, key })
        const id = uuidv7()
        yield* sql`INSERT INTO models ${sql.insert({
          id,
          connection_id: connectionId,
          model_key: key,
          source: "user",
          overrides_json: JSON.stringify(overrides),
          created_at: Date.now()
        })}`
        return yield* reloadModel(id)
      }).pipe(transaction(sql, "AddUserModel")),

    EditModel: ({ userId, modelId, overrides, expectedRowVersion }) =>
      Effect.gen(function* () {
        yield* modelAt(userId, modelId, expectedRowVersion)
        yield* sql`UPDATE models SET overrides_json = ${JSON.stringify(overrides)}, row_version = row_version + 1
                   WHERE id = ${modelId}`
        return yield* reloadModel(modelId)
      }).pipe(transaction(sql, "EditModel")),

    SetModelHidden: ({ userId, modelId, hidden }) =>
      Effect.gen(function* () {
        yield* ownedModel(userId, modelId)
        yield* sql`UPDATE models SET hidden = ${hidden ? 1 : 0}, row_version = row_version + 1 WHERE id = ${modelId}`
        return yield* reloadModel(modelId)
      }).pipe(transaction(sql, "SetModelHidden")),

    SetAppSetting: ({ key, value }) =>
      sql`INSERT INTO app_settings (key, value_json) VALUES (${key}, ${JSON.stringify(value)})
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`.pipe(
        Effect.asVoid,
        transaction(sql, "SetAppSetting")
      ),

    OpenLlmRequest: ({ userId, request }) =>
      Effect.gen(function* () {
        yield* ownedConnection(userId, request.connectionId)
        const admission = yield* admitRequest(sql, userId, request)
        if (!admission.allowed) return false
        // The database also checks that the chat is this user's and the model is this
        // connection's (schema/providers.ts).
        yield* sql`INSERT INTO llm_requests ${sql.insert({
          id: request.id,
          owner_user_id: userId,
          connection_id: request.connectionId,
          model_id: request.modelId,
          chat_id: request.chatId,
          rollout_id: request.rolloutId,
          version_id: request.versionId,
          purpose: request.purpose,
          api: request.api,
          provider: request.provider,
          model_key: request.modelKey,
          status: "running",
          backfill_id: admission.backfillId,
          reserved_tokens: admission.backfillId ? request.reservation!.tokens : null,
          reserved_cost: admission.backfillId ? request.reservation!.cost : null,
          reserved_currency: admission.backfillId ? request.reservation!.currency : null,
          started_at: request.startedAt
        })}`
        return true
      }).pipe(transaction(sql, "OpenLlmRequest")),

    CloseLlmRequest: ({ userId, request }) =>
      Effect.gen(function* () {
        const { counts, cost } = request
        const rows = yield* sql`UPDATE llm_requests SET ${sql.update({
          cache_identity_json: request.cacheIdentity == null ? null : JSON.stringify(request.cacheIdentity),
          cache_stagger_json: request.cacheStagger == null ? null : JSON.stringify(request.cacheStagger),
          status: request.status,
          ended_at: request.endedAt,
          first_token_at: request.firstTokenAt,
          response_model: request.responseModel,
          upstream: request.upstream,
          input_uncached: counts.inputUncached,
          cache_read: counts.cacheRead,
          cache_write: counts.cacheWrite,
          cache_write_long: counts.cacheWriteLong,
          output: counts.output,
          reasoning: counts.reasoning,
          usage_source: request.usageSource,
          raw_usage_json: request.rawUsage === null ? null : JSON.stringify(request.rawUsage),
          reported_cost: request.reportedCost,
          cost: cost?.amount ?? null,
          cost_currency: cost?.currency ?? null,
          cost_formula: cost?.formula ?? null,
          error_json: request.error === null ? null : JSON.stringify(request.error)
        })}
        WHERE id = ${request.id} AND owner_user_id = ${userId} AND status = 'running' RETURNING id`
        if (rows.length === 0) return yield* new NotFound({ entity: "running request", id: request.id })
      }).pipe(transaction(sql, "CloseLlmRequest")),

    InterruptRunningLlmRequests: () =>
      sql`UPDATE llm_requests SET status = 'interrupted', ended_at = ${Date.now()}
          WHERE status = 'running' RETURNING id`.pipe(
        Effect.map((rows) => ({ interrupted: rows.length })),
        transaction(sql, "InterruptRunningLlmRequests")
      )
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  return handlers
})
