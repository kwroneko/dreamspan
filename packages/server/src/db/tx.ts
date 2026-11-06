import { validateStorageKindWrites } from "./storageKinds.ts"
import { Effect } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { toStorageError } from "./connection.ts"
import type { StorageError } from "./ops.ts"
import { settleSummaries } from "./summaryValidity.ts"
import { timed } from "./timed.ts"

/** Turns driver errors into the typed StorageError that crosses the worker boundary, and logs them in the worker. */
const typedErrors =
  (operation: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E | SqlError.SqlError, R>
  ): Effect.Effect<A, Exclude<E, SqlError.SqlError> | StorageError, R> =>
    Effect.catch(effect, (error): Effect.Effect<never, Exclude<E, SqlError.SqlError> | StorageError> => {
      if (!SqlError.isSqlError(error)) return Effect.fail(error as Exclude<E, SqlError.SqlError>)
      const storageError = toStorageError(operation)(error)
      return Effect.logError(
        `storage operation ${operation} failed (${storageError.reason}): ${storageError.message}`
      ).pipe(Effect.andThen(Effect.fail(storageError)))
    })

/**
 * A write operation: one transaction, typed errors, and the slow-operation log. Before it
 * commits, the shell summaries its writes left right are kept valid (db/summaryValidity.ts).
 */
export const transaction =
  (sql: SqlClient.SqlClient, operation: string) =>
  <A, E, R>(body: Effect.Effect<A, E | SqlError.SqlError, R>) =>
    sql
      .withTransaction(
        Effect.tap(body, () => Effect.andThen(validateStorageKindWrites(sql, operation), settleSummaries(sql)))
      )
      .pipe(typedErrors(operation), timed(operation))

/**
 * A read operation: one read transaction, so all its statements see the same snapshot,
 * plus typed errors and the slow-operation log.
 */
export const query =
  (operation: string) =>
  <A, E, R>(body: Effect.Effect<A, E | SqlError.SqlError, R>) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(body)).pipe(
      typedErrors(operation),
      timed(operation)
    )
