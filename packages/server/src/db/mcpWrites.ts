// MCP connection, use and ledger writes (spec/MCP.md §12), in the writer worker, each one
// transaction. Secrets arrive encrypted; the main thread's MCP client does the network work
// between these.
import type { UserId } from "@dreamspan/shared/domain.ts"
import { mcpKeyFor, type McpConnectionSettings } from "@dreamspan/shared/mcp.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeMcpQueries, toMcpConnection } from "./mcpRows.ts"
import { NotFound, StaleWrite, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

/**
 * The key a user's tools of a shared connection are offered under (spec/MCP.md §4.2): its own,
 * else with a number, never one the user already has (their own connections' keys and the keys
 * their other uses are offered under). Up to 26 characters, as the column allows.
 */
const offeredKeyFor = (key: string, taken: ReadonlySet<string>) => {
  if (!taken.has(key)) return key
  for (let n = 2; ; n++) {
    const suffix = String(n)
    const offered = `${key.slice(0, 26 - suffix.length)}${suffix}`
    if (!taken.has(offered)) return offered
  }
}

/**
 * Gives a user their own use of every connection shared with them that they have none of yet, in
 * creation order, so the first keeps its key (spec/MCP.md §3, §4.2). Part of the calling
 * transaction: sharing a connection, and making a user while one is shared with everyone. A
 * shared connection's tools listed so far start allowed, as at a first Check.
 */
export const ensureSharedUses = (sql: SqlClient.SqlClient, userId: UserId, at: number) =>
  Effect.gen(function* () {
    const missing = yield* sql<{ id: string; key: string; catalog_revision: number }>`
      SELECT m.id, m.key, m.catalog_revision FROM mcp_connections m
      WHERE m.purged_at IS NULL AND m.owner_user_id <> ${userId}
        AND (m.share_scope = 'all' OR (m.share_scope = 'chosen' AND EXISTS (
          SELECT 1 FROM mcp_connection_shares s WHERE s.connection_id = m.id AND s.user_id = ${userId})))
        AND NOT EXISTS (SELECT 1 FROM mcp_uses u WHERE u.connection_id = m.id AND u.user_id = ${userId})
      ORDER BY m.created_at, m.id`
    if (missing.length === 0) return
    const taken = new Set(
      (yield* sql<{ key: string }>`
        SELECT key FROM mcp_connections WHERE owner_user_id = ${userId} AND purged_at IS NULL
        UNION SELECT offered_key AS key FROM mcp_uses WHERE user_id = ${userId}`).map((row) => row.key)
    )
    for (const connection of missing) {
      const offered = offeredKeyFor(connection.key, taken)
      taken.add(offered)
      yield* sql`INSERT INTO mcp_uses ${sql.insert({
        connection_id: connection.id,
        user_id: userId,
        offered_key: offered,
        reviewed_revision: connection.catalog_revision,
        updated_at: at
      })}`
    }
  })

/** Where a connection's calls go: an address, or a local program's argument list (no shell). */
const reach = (settings: McpConnectionSettings) =>
  settings.transport === "stdio"
    ? {
        url: null,
        command_json: JSON.stringify([settings.program?.command ?? "", ...(settings.program?.args ?? [])])
      }
    : { url: settings.url, command_json: null }

/** A stored error line: at most what the column holds. */
const errorLine = (text: string) => (text.length > 1000 ? `${text.slice(0, 999)}…` : text)

export const makeMcpWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { owned, mine } = makeMcpQueries(sql)
  const reload = (userId: UserId, connectionId: string) => Effect.map(owned(userId, connectionId), toMcpConnection)

  const checkCredential = (userId: UserId, credentialId: string | null) =>
    credentialId === null
      ? Effect.void
      : sql`SELECT 1 FROM credentials WHERE id = ${credentialId} AND owner_user_id = ${userId}`.pipe(
          Effect.flatMap(([row]) =>
            row ? Effect.void : Effect.fail(new NotFound({ entity: "credential", id: credentialId }))
          )
        )

  const insertCredential = (
    userId: UserId,
    credential: {
      readonly credentialId: string
      readonly name: string
      readonly key: { readonly enc: Uint8Array; readonly hint: string }
      readonly origins: ReadonlyArray<string>
    },
    at: number
  ) =>
    sql`INSERT INTO credentials ${sql.insert({
      id: credential.credentialId,
      owner_user_id: userId,
      name: credential.name,
      key_enc: credential.key.enc,
      key_hint: credential.key.hint,
      origins_json: JSON.stringify([...new Set(credential.origins)]),
      connection_owned: 1,
      created_at: at,
      updated_at: at
    })}`

  /** A key a connection owned goes once nothing uses it, so a rotated key doesn't stay at rest. */
  const dropOwnedKey = (credentialId: string | null) =>
    credentialId === null
      ? Effect.void
      : sql`DELETE FROM credentials WHERE id = ${credentialId} AND connection_owned = 1
          AND NOT EXISTS (SELECT 1 FROM connections WHERE credential_id = ${credentialId})
          AND NOT EXISTS (SELECT 1 FROM mcp_connections WHERE credential_id = ${credentialId})`

  const expectVersion = (connectionId: string, actual: number, expected: number) =>
    actual === expected
      ? Effect.void
      : Effect.fail(new StaleWrite({ entity: "mcp_connection", id: connectionId, expected, actual }))

  /** Changes how calls are sent: the row and cache revisions advance, so open clients close. */
  const changeSending = (connectionId: string, columns: Record<string, unknown>, at: number) =>
    sql`UPDATE mcp_connections SET ${sql.update({ ...columns, updated_at: at })},
        row_version = row_version + 1, cache_revision = cache_revision + 1
      WHERE id = ${connectionId}`

  const handlers = {
    CreateMcpConnection: ({ userId, connectionId, settings, credential, at }) =>
      Effect.gen(function* () {
        const credentialId = "typed" in credential ? credential.typed.credentialId : credential.existing
        if ("typed" in credential) yield* insertCredential(userId, credential.typed, at)
        else yield* checkCredential(userId, credentialId)
        // Keys of the user's other connections, binned ones included (they may come back), and
        // the keys their uses are offered under.
        const taken = yield* sql<{ key: string }>`
          SELECT key FROM mcp_connections WHERE owner_user_id = ${userId} AND purged_at IS NULL
          UNION SELECT offered_key AS key FROM mcp_uses WHERE user_id = ${userId}`
        const key = mcpKeyFor(settings.name, new Set(taken.map((row) => row.key)))
        yield* sql`INSERT INTO mcp_connections ${sql.insert({
          id: connectionId,
          owner_user_id: userId,
          name: settings.name,
          key,
          about: settings.about,
          transport: settings.transport,
          ...reach(settings),
          credential_id: credentialId,
          timeout_s: settings.timeoutS,
          created_at: at,
          updated_at: at
        })}`
        yield* sql`INSERT INTO mcp_uses ${sql.insert({
          connection_id: connectionId,
          user_id: userId,
          offered_key: key,
          updated_at: at
        })}`
        return yield* reload(userId, connectionId)
      }).pipe(transaction(sql, "CreateMcpConnection")),

    UpdateMcpConnection: ({ userId, connectionId, settings, expectedRowVersion, at }) =>
      Effect.gen(function* () {
        const row = yield* mine(userId, connectionId)
        yield* expectVersion(connectionId, row.row_version, expectedRowVersion)
        const next = reach(settings)
        const local = settings.transport === "stdio"
        const switched = (row.transport === "stdio") !== local
        const sending =
          row.url !== next.url ||
          row.command_json !== next.command_json ||
          row.transport !== settings.transport ||
          row.timeout_s !== settings.timeoutS
        // Switching between a remote server and a local program drops what only the other uses:
        // a key, headers and a route, or the program's environment.
        const dropped = !switched
          ? {}
          : local
            ? {
                credential_id: null,
                headers_enc: null,
                header_names_json: "[]",
                headers_origin: null,
                proxy_mode: "inherit",
                proxy_url_enc: null
              }
            : { env_enc: null, env_names_json: "[]" }
        yield* sql`UPDATE mcp_connections SET ${sql.update({
          name: settings.name,
          about: settings.about,
          transport: settings.transport,
          ...next,
          ...dropped,
          timeout_s: settings.timeoutS,
          updated_at: at
        })}, row_version = row_version + 1, cache_revision = cache_revision + ${sending ? 1 : 0}
          WHERE id = ${connectionId}`
        if (switched && local) yield* dropOwnedKey(row.credential_id)
        return yield* reload(userId, connectionId)
      }).pipe(transaction(sql, "UpdateMcpConnection")),

    SetMcpKey: ({ userId, connectionId, expectedRowVersion, credential, at }) =>
      Effect.gen(function* () {
        const row = yield* mine(userId, connectionId)
        yield* expectVersion(connectionId, row.row_version, expectedRowVersion)
        if (credential) yield* insertCredential(userId, credential, at)
        yield* changeSending(connectionId, { credential_id: credential?.credentialId ?? null }, at)
        yield* dropOwnedKey(row.credential_id)
        return yield* reload(userId, connectionId)
      }).pipe(transaction(sql, "SetMcpKey")),

    SetMcpCredential: ({ userId, connectionId, credentialId, at }) =>
      Effect.gen(function* () {
        const row = yield* mine(userId, connectionId)
        yield* checkCredential(userId, credentialId)
        yield* changeSending(connectionId, { credential_id: credentialId }, at)
        if (row.credential_id !== credentialId) yield* dropOwnedKey(row.credential_id)
        return yield* reload(userId, connectionId)
      }).pipe(transaction(sql, "SetMcpCredential")),

    SetMcpHeaders: ({ userId, connectionId, expectedRowVersion, headers, at }) =>
      Effect.gen(function* () {
        const row = yield* mine(userId, connectionId)
        yield* expectVersion(connectionId, row.row_version, expectedRowVersion)
        yield* changeSending(
          connectionId,
          {
            headers_enc: headers?.enc ?? null,
            header_names_json: JSON.stringify(headers?.names ?? []),
            headers_origin: headers?.origin ?? null
          },
          at
        )
        return yield* reload(userId, connectionId)
      }).pipe(transaction(sql, "SetMcpHeaders")),

    SetMcpEnvironment: ({ userId, connectionId, expectedRowVersion, env, at }) =>
      Effect.gen(function* () {
        const row = yield* mine(userId, connectionId)
        yield* expectVersion(connectionId, row.row_version, expectedRowVersion)
        // A trigger refuses this for anyone but an admin, and for a remote server (a CHECK).
        yield* changeSending(
          connectionId,
          { env_enc: env?.enc ?? null, env_names_json: JSON.stringify(env?.names ?? []) },
          at
        )
        return yield* reload(userId, connectionId)
      }).pipe(transaction(sql, "SetMcpEnvironment")),

    SetMcpProxy: ({ userId, connectionId, mode, urlEnc, at }) =>
      Effect.gen(function* () {
        yield* mine(userId, connectionId)
        yield* changeSending(connectionId, { proxy_mode: mode, proxy_url_enc: mode === "custom" ? urlEnc : null }, at)
        return yield* reload(userId, connectionId)
      }).pipe(transaction(sql, "SetMcpProxy")),

    SaveMcpCatalog: ({ userId, connectionId, expectedCacheRevision, expectedCatalogRevision, outcome, at }) =>
      Effect.gen(function* () {
        const row = yield* owned(userId, connectionId)
        // The address or key changed while the server was asked: this listing is someone else's.
        yield* expectVersion(connectionId, row.cache_revision, expectedCacheRevision)
        yield* expectVersion(connectionId, row.catalog_revision, expectedCatalogRevision)
        if ("error" in outcome) {
          yield* sql`UPDATE mcp_connections SET check_error = ${errorLine(outcome.error)}, updated_at = ${at}
            WHERE id = ${connectionId}`
          return yield* reload(userId, connectionId)
        }
        const tools = JSON.stringify(outcome.tools)
        const changed = tools !== row.tools_json
        const revision = changed ? row.catalog_revision + 1 : row.catalog_revision
        yield* sql`UPDATE mcp_connections SET ${sql.update({
          server_json: JSON.stringify(outcome.server),
          tools_json: tools,
          catalog_revision: revision,
          listed_at: at,
          check_error: null,
          updated_at: at
        })} WHERE id = ${connectionId}`
        // The first listing is what the user added the server for: its tools start on.
        if (row.catalog_revision === 0 && revision === 1)
          yield* sql`UPDATE mcp_uses SET reviewed_revision = 1, updated_at = ${at}
            WHERE connection_id = ${connectionId} AND reviewed_revision = 0`
        return yield* reload(userId, connectionId)
      }).pipe(transaction(sql, "SaveMcpCatalog")),

    SetMcpUse: ({ userId, connectionId, stories, workshops, tools, at }) =>
      Effect.gen(function* () {
        const row = yield* owned(userId, connectionId)
        yield* sql`UPDATE mcp_uses SET ${sql.update({
          ...(stories === undefined ? {} : { stories: stories ? 1 : 0 }),
          ...(workshops === undefined ? {} : { workshops: workshops ? 1 : 0 }),
          ...(tools === undefined
            ? {}
            : {
                tools_json: JSON.stringify(tools.choices),
                // Never past what was listed, so a later listing's tools still start off.
                reviewed_revision: Math.max(0, Math.min(tools.reviewedRevision, row.catalog_revision))
              }),
          updated_at: at
        })}, row_version = row_version + 1
          WHERE connection_id = ${connectionId} AND user_id = ${userId}`
        return yield* reload(userId, connectionId)
      }).pipe(transaction(sql, "SetMcpUse")),

    SetMcpLoading: ({ userId, connectionId, loading, useInstructions, at }) =>
      Effect.gen(function* () {
        yield* mine(userId, connectionId)
        yield* sql`UPDATE mcp_connections SET ${sql.update({
          ...(loading === undefined ? {} : { loading }),
          ...(useInstructions === undefined ? {} : { use_instructions: useInstructions ? 1 : 0 }),
          updated_at: at
        })}, row_version = row_version + 1 WHERE id = ${connectionId}`
        return yield* reload(userId, connectionId)
      }).pipe(transaction(sql, "SetMcpLoading")),

    SetMcpOAuth: ({ userId, connectionId, oauth, expectedEnc, at }) =>
      Effect.gen(function* () {
        yield* owned(userId, connectionId)
        // A refresh stores its tokens only over the sign-in it refreshed: a sign-out or a new
        // sign-in meanwhile wins.
        const updated = yield* sql`UPDATE mcp_uses SET ${sql.update({
          oauth_enc: oauth?.enc ?? null,
          oauth_origin: oauth?.origin ?? null,
          oauth_expires_at: oauth?.expiresAt ?? null,
          updated_at: at
        })}, row_version = row_version + 1
          WHERE connection_id = ${connectionId} AND user_id = ${userId}
            AND (${expectedEnc === undefined ? 1 : 0} = 1 OR oauth_enc = ${expectedEnc ?? null})
          RETURNING row_version`
        if (updated.length === 0)
          return yield* new StaleWrite({ entity: "mcp_connection", id: connectionId, expected: 0, actual: 0 })
        return yield* reload(userId, connectionId)
      }).pipe(transaction(sql, "SetMcpOAuth")),

    SetMcpShare: ({ userId, connectionId, scope, userIds, at }) =>
      Effect.gen(function* () {
        yield* mine(userId, connectionId)
        // Only real users other than the owner; the owner always has their own use.
        const chosen =
          scope === "chosen"
            ? (yield* sql<{
                id: string
              }>`SELECT id FROM users WHERE id IN ${sql.in(userIds.length ? [...userIds] : [""])}
                AND id <> ${userId} ORDER BY id`).map((row) => row.id)
            : []
        // A trigger refuses sharing by anyone but an admin.
        yield* sql`UPDATE mcp_connections SET share_scope = ${scope}, updated_at = ${at},
          row_version = row_version + 1 WHERE id = ${connectionId}`
        yield* sql`DELETE FROM mcp_connection_shares WHERE connection_id = ${connectionId}`
        for (const user of chosen)
          yield* sql`INSERT INTO mcp_connection_shares ${sql.insert({
            connection_id: connectionId,
            user_id: user,
            created_at: at
          })}`
        // Who lost it loses their use, sign-in and choices; who gained it gets theirs.
        yield* sql`DELETE FROM mcp_uses WHERE connection_id = ${connectionId} AND user_id <> ${userId}
          AND NOT (${scope} = 'all' OR user_id IN ${sql.in(chosen.length ? chosen : [""])})`
        const gaining =
          scope === "all"
            ? (yield* sql<{ id: string }>`SELECT id FROM users WHERE id <> ${userId}`).map((row) => row.id)
            : chosen
        for (const user of gaining) yield* ensureSharedUses(sql, user as UserId, at)
        return yield* reload(userId, connectionId)
      }).pipe(transaction(sql, "SetMcpShare")),

    OpenMcpCall: ({ userId, call }) =>
      Effect.gen(function* () {
        // A connection the user has a use of (their own, or one shared with them) that isn't
        // purged: a call may still be closing after a delete.
        const [connection] = yield* sql`SELECT 1 FROM mcp_connections m
          JOIN mcp_uses u ON u.connection_id = m.id AND u.user_id = ${userId}
          WHERE m.id = ${call.connectionId} AND m.purged_at IS NULL`
        if (!connection) return yield* new NotFound({ entity: "mcp_connection", id: call.connectionId })
        if (call.chatId !== null) {
          const [chat] = yield* sql`SELECT 1 FROM chats WHERE id = ${call.chatId} AND owner_user_id = ${userId}`
          if (!chat) return yield* new NotFound({ entity: "chat", id: call.chatId })
        }
        yield* sql`INSERT INTO mcp_calls ${sql.insert({
          id: call.id,
          owner_user_id: userId,
          connection_id: call.connectionId,
          connection_revision: call.connectionRevision,
          method: call.method,
          tool: call.tool,
          purpose: call.purpose,
          chat_id: call.chatId,
          rollout_id: call.rolloutId,
          tool_call_id: call.toolCallId,
          attempt: call.attempt,
          status: "running",
          started_at: call.startedAt
        })}`
      }).pipe(transaction(sql, "OpenMcpCall")),

    CloseMcpCall: ({ userId, callId, status, endedAt, sentBytes, receivedBytes, error }) =>
      Effect.gen(function* () {
        if (status === "running") return false
        const rows = yield* sql`UPDATE mcp_calls SET ${sql.update({
          status,
          ended_at: endedAt,
          sent_bytes: sentBytes,
          received_bytes: receivedBytes,
          error: error === null ? null : errorLine(error)
        })} WHERE id = ${callId} AND owner_user_id = ${userId} AND status = 'running' RETURNING id`
        return rows.length > 0
      }).pipe(transaction(sql, "CloseMcpCall")),

    InterruptRunningMcpCalls: () =>
      sql`UPDATE mcp_calls SET status = 'interrupted', ended_at = ${Date.now()}
          WHERE status = 'running' RETURNING id`.pipe(
        Effect.map((rows) => ({ interrupted: rows.length })),
        transaction(sql, "InterruptRunningMcpCalls")
      )
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  return handlers
})
