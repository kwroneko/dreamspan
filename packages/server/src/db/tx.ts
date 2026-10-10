import { Effect } from "effect"
import { type SqlClient, SqlError } from "effect/sql"
import { toStorageError } from "./connection.ts"
import type { StorageError } from "./ops.ts"
import { timed } from "./timed.ts"

/** Turns driver errors into the typed StorageError that crosses the worker boundary. */
const typedErrors =
  (operation: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E | SqlError.SqlError, R>
  ): Effect.Effect<A, Exclude<E, SqlError.SqlError> | StorageError, R> =>
    effect.pipe(
      Effect.mapError((error): Exclude<E, SqlError.SqlError> | StorageError =>
        error instanceof SqlError.SqlError ? toStorageError(operation)(error) : (error as Exclude<E, SqlError.SqlError>)
      )
    )

/** A write operation: one transaction, typed errors, and the slow-operation log. */
export const transaction =
  (sql: SqlClient.SqlClient, operation: string) =>
  <A, E, R>(body: Effect.Effect<A, E | SqlError.SqlError, R>) =>
    sql.withTransaction(body).pipe(typedErrors(operation), timed(operation))

/** A read operation: typed errors and the slow-operation log. */
export const query =
  (operation: string) =>
  <A, E, R>(body: Effect.Effect<A, E | SqlError.SqlError, R>) =>
    body.pipe(typedErrors(operation), timed(operation))
