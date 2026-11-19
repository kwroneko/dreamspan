// Users, passwords and sessions (DESIGN §10.1). Writes run in the writer worker, each as
// one transaction; passwords arrive already hashed, and session tokens as their hash.
import { UserAccount, type UserId, type UserRole } from "@dreamspan/shared/domain.ts"
import { AccountRejected, NotFound } from "@dreamspan/shared/errors.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { type ReadOps, UserDisabled, type WriteOps } from "./ops.ts"
import { toUser, type UserRow } from "./rows.ts"
import { query, transaction } from "./tx.ts"

interface AccountRow extends UserRow {
  readonly password_hash: string | null
  readonly disabled_at: number | null
}

const toAccount = (row: AccountRow) =>
  new UserAccount({
    ...toUser(row),
    hasPassword: row.password_hash !== null,
    disabled: row.disabled_at !== null
  })

export const makeAccountWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const insertUser = (handle: string, displayName: string, role: UserRole, passwordHash: string | null) =>
    sql<AccountRow>`INSERT INTO users ${sql.insert({
      id: uuidv7(),
      handle,
      display_name: displayName,
      role,
      created_at: Date.now(),
      password_hash: passwordHash
    })} RETURNING *`.pipe(Effect.map(([row]) => row!))

  const userById = (userId: UserId) =>
    sql<AccountRow>`SELECT * FROM users WHERE id = ${userId}`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "user", id: userId }))))
    )

  const endSessions = (userId: string) => sql`DELETE FROM sessions WHERE user_id = ${userId}`

  return {
    EnsureUser: ({ handle, displayName }) =>
      Effect.gen(function* () {
        const [existing] = yield* sql<AccountRow>`SELECT * FROM users WHERE handle = ${handle}`
        if (existing?.disabled_at != null) return yield* new UserDisabled({ handle })
        if (existing) return toUser(existing)
        // The first user of an instance administers it.
        const [count] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM users`
        return toUser(yield* insertUser(handle, displayName, count?.n === 0 ? "admin" : "user", null))
      }).pipe(transaction(sql, "EnsureUser")),

    CreateUser: ({ handle, displayName, role, passwordHash }) =>
      Effect.gen(function* () {
        const [taken] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM users WHERE handle = ${handle}`
        if (taken!.n > 0) return yield* new AccountRejected({ reason: "handle_taken", message: `${handle} is taken` })
        return toAccount(yield* insertUser(handle, displayName, role, passwordHash))
      }).pipe(transaction(sql, "CreateUser")),

    SetPasswordHash: ({ userId, passwordHash }) =>
      Effect.gen(function* () {
        yield* userById(userId)
        yield* sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${userId}`
        yield* endSessions(userId)
      }).pipe(transaction(sql, "SetPasswordHash")),

    SetUserDisabled: ({ userId, disabled }) =>
      Effect.gen(function* () {
        const row = yield* userById(userId)
        if (disabled && row.role === "admin" && row.disabled_at === null) {
          const [admins] = yield* sql<{ n: number }>`
            SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL`
          if (admins!.n <= 1) {
            return yield* new AccountRejected({ reason: "last_admin", message: "the last admin can't be disabled" })
          }
        }
        if (disabled) yield* endSessions(userId)
        const [updated] = yield* sql<AccountRow>`
          UPDATE users SET disabled_at = ${disabled ? (row.disabled_at ?? Date.now()) : null}
          WHERE id = ${userId} RETURNING *`
        return toAccount(updated!)
      }).pipe(transaction(sql, "SetUserDisabled")),

    BootstrapAdmin: ({ handle, passwordHash }) =>
      Effect.gen(function* () {
        const [admins] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM users
          WHERE role = 'admin' AND password_hash IS NOT NULL AND disabled_at IS NULL`
        if (admins!.n > 0) return null
        const [target] =
          handle === null
            ? yield* sql<AccountRow>`SELECT * FROM users WHERE role = 'admin' AND disabled_at IS NULL
                ORDER BY created_at, id LIMIT 1`
            : yield* sql<AccountRow>`SELECT * FROM users WHERE handle = ${handle}`
        if (!target) return toUser(yield* insertUser(handle ?? "admin", handle ?? "admin", "admin", passwordHash))
        const [updated] = yield* sql<AccountRow>`
          UPDATE users SET password_hash = ${passwordHash}, role = 'admin', disabled_at = NULL
          WHERE id = ${target.id} RETURNING *`
        return toUser(updated!)
      }).pipe(transaction(sql, "BootstrapAdmin")),

    CreateSession: ({ tokenHash, userId, expiresAt }) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM sessions WHERE expires_at <= ${Date.now()}`
        yield* sql`INSERT INTO sessions ${sql.insert({
          token_hash: tokenHash,
          user_id: userId,
          created_at: Date.now(),
          expires_at: expiresAt
        })}`
      }).pipe(transaction(sql, "CreateSession")),

    DeleteSession: ({ tokenHash }) =>
      sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`.pipe(Effect.asVoid, transaction(sql, "DeleteSession"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})

export const makeAccountReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  return {
    GetSessionUser: ({ tokenHash, now }) =>
      sql<UserRow>`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ${tokenHash} AND s.expires_at > ${now} AND u.disabled_at IS NULL`.pipe(
        Effect.map(([row]) => (row ? toUser(row) : null)),
        query("GetSessionUser")
      ),

    GetPasswordHash: (by) =>
      ("handle" in by
        ? sql<AccountRow>`SELECT * FROM users WHERE handle = ${by.handle} AND disabled_at IS NULL`
        : sql<AccountRow>`SELECT * FROM users WHERE id = ${by.userId} AND disabled_at IS NULL`
      ).pipe(
        Effect.map(([row]) => (row ? { user: toUser(row), passwordHash: row.password_hash } : null)),
        query("GetPasswordHash")
      ),

    ListUsers: () =>
      sql<AccountRow>`SELECT * FROM users ORDER BY created_at, id`.pipe(
        Effect.map((rows) => rows.map(toAccount)),
        query("ListUsers")
      ),

    AccountsConfigured: () =>
      sql<{ n: number }>`SELECT count(*) AS n FROM users WHERE password_hash IS NOT NULL AND disabled_at IS NULL`.pipe(
        Effect.map(([row]) => row!.n > 0),
        query("AccountsConfigured")
      ),

    FirstAdmin: () =>
      sql<UserRow>`SELECT * FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY created_at, id LIMIT 1`.pipe(
        Effect.map(([row]) => (row ? toUser(row) : null)),
        query("FirstAdmin")
      )
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
