// How RPC handlers report failures the client can't act on: storage and worker failures are
// logged here and become ServerError, without internals; every other error keeps its tag.
import { ServerError } from "@dreamspan/shared/errors.ts"
import { Effect } from "effect"
import { RpcClientError } from "effect/rpc"
import { StorageError } from "../db/ops.ts"

export const toServerError = (operation: string) => (error: unknown) =>
  Effect.logError(`${operation} failed`, error).pipe(
    Effect.andThen(Effect.fail(new ServerError({ message: `${operation} failed` })))
  )

type Internal = StorageError | RpcClientError.RpcClientError

const isInternal = <E>(error: E): error is Extract<E, Internal> =>
  error instanceof StorageError || error instanceof RpcClientError.RpcClientError

export const internal =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, Internal> | ServerError, R> =>
    Effect.catchIf(effect, isInternal, toServerError(operation)) as Effect.Effect<
      A,
      Exclude<E, Internal> | ServerError,
      R
    >
